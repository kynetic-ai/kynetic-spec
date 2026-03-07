<!--
  AC: @ui-reference-display ac-1 — Shared ReferenceLink component for consistent display
  of cross-references (task, spec, plan, session). Normalizes @ prefix, shows resolved
  title with slug/ULID as secondary, and links to the appropriate detail view.
  Falls back to raw ref display if resolution fails.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import type { RefType } from '$lib/utils/reference';
	import { normalizeRef, shortRef, refHref } from '$lib/utils/reference';

	interface Props {
		/** The raw reference string (may include @ prefix). */
		ref: string;
		/** The entity type this reference points to. */
		type: RefType;
		/** Resolved title for the entity, if available. */
		title?: string | null;
		/** Whether to render as a clickable link (default: true). */
		linked?: boolean;
		/** Stop click propagation (useful when nested inside clickable containers). */
		stopPropagation?: boolean;
		/** Additional CSS classes. */
		class?: string;
	}

	let {
		ref: rawRef,
		type,
		title = null,
		linked = true,
		stopPropagation = false,
		class: className = ''
	}: Props = $props();

	let normalized = $derived(normalizeRef(rawRef));
	let short = $derived(shortRef(rawRef));
	let href = $derived(refHref(type, rawRef, base));

	function handleClick(e: MouseEvent) {
		if (stopPropagation) {
			e.stopPropagation();
		}
	}
</script>

{#if linked}
	<a
		{href}
		class="inline-flex items-baseline gap-1 text-primary hover:underline {className}"
		onclick={handleClick}
		title={rawRef}
		data-testid="reference-link"
		data-ref-type={type}
	>
		{#if title}
			<span class="text-sm">{title}</span>
			<span class="text-[10px] font-mono text-muted-foreground">@{short}</span>
		{:else}
			<span class="text-sm font-mono">@{normalized}</span>
		{/if}
	</a>
{:else}
	<span
		class="inline-flex items-baseline gap-1 {className}"
		title={rawRef}
		data-testid="reference-link"
		data-ref-type={type}
	>
		{#if title}
			<span class="text-sm">{title}</span>
			<span class="text-[10px] font-mono text-muted-foreground">@{short}</span>
		{:else}
			<span class="text-sm font-mono text-muted-foreground">@{normalized}</span>
		{/if}
	</span>
{/if}
