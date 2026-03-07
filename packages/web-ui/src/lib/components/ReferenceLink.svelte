<!--
  AC: @ui-reference-display ac-1 — Shared ReferenceLink component for consistent display
  of cross-references (task, spec, plan, session). Normalizes @ prefix, shows resolved
  title with slug/ULID as secondary, and links to the appropriate detail view.
  Falls back to raw ref display if resolution fails.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
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
		/**
		 * Use an interactive <span> instead of <a> for the link.
		 * Navigates via goto() on click. Use when nested inside <a> or <button>
		 * to avoid invalid HTML (nested interactive elements).
		 * Implies stopPropagation and preventDefault.
		 */
		inline?: boolean;
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
		inline = false,
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

	function handleInlineClick(e: Event) {
		e.stopPropagation();
		e.preventDefault();
		goto(href);
	}
</script>

{#snippet refContent()}
	{#if title}
		<span class="text-sm">{title}</span>
		<span class="text-[10px] font-mono text-muted-foreground">@{short}</span>
	{:else}
		<span class="text-sm font-mono">@{normalized}</span>
	{/if}
{/snippet}

{#if linked && inline}
	<!-- Interactive span: navigates via goto(), safe inside <a>/<button> -->
	<span
		class="inline-flex items-baseline gap-1 text-primary hover:underline cursor-pointer {className}"
		onclick={handleInlineClick}
		onkeydown={(e) => e.key === 'Enter' && handleInlineClick(e)}
		title={rawRef}
		role="link"
		tabindex="0"
		data-testid="reference-link"
		data-ref-type={type}
		data-href={href}
	>
		{@render refContent()}
	</span>
{:else if linked}
	<a
		{href}
		class="inline-flex items-baseline gap-1 text-primary hover:underline {className}"
		onclick={handleClick}
		title={rawRef}
		data-testid="reference-link"
		data-ref-type={type}
	>
		{@render refContent()}
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
