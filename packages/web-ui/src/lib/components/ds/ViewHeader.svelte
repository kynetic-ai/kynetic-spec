<!--
  ViewHeader — the standard entity-view header.

  Fixed zones, in inline order:
    1. Leading chrome reservation — always empty, sized by the shell's single
       named reservation value (`--ds-chrome-leading-reservation`). No header
       element occupies it, so a native wrapper can later add window controls
       without relocating header content. (@web-shell-platform-target,
       @ui-view-header ac-3)
    2. Entity reference — slug/ULID, copyable. (@ui-view-header ac-1)
    3. State indicator — a single token from the shared status vocabulary, plus
       an optional `badges` snippet for compound state. (@ui-view-header ac-1, ac-2)
    4. Child counts — server-resolved values only; the component offers no
       fetch-and-count path. (@ui-view-header ac-1, ac-4)
    5. View-actions slot — view-specific actions, each keyboard-operable.
       (@ui-view-header ac-1, ac-5)

  Spec: @ui-view-header
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';
	import { shortRef } from '$lib/utils/reference';
	import StatusBadge from './StatusBadge.svelte';
	import type { StatusDomain } from '$lib/ds/status-tokens';

	/** A single server-resolved child count. */
	export interface ViewHeaderCount {
		/** Count label, e.g. "threads". */
		label: string;
		/** Server-resolved numeric value. */
		value: number;
		/** Optional test id for the count element. */
		testid?: string;
	}

	interface Props {
		/** Entity reference (slug or ULID); displayed shortened and copyable. */
		reference: string;
		/** Optional entity title/name shown before the reference. */
		title?: string;
		/** Optional test id for the title element (defaults to `view-header-title`). */
		titleTestid?: string;
		/** Status-token domain for the primary state indicator. */
		statusDomain?: StatusDomain;
		/** State value for the primary state indicator. */
		statusState?: string;
		/** Optional test id forwarded to the primary state badge. */
		statusTestid?: string;
		/**
		 * Server-resolved child counts. Values are rendered as-is — the header
		 * never enumerates or fetches entity lists to derive them.
		 */
		counts?: ViewHeaderCount[];
		/** Optional additional state chips rendered in the state zone. */
		badges?: Snippet;
		/** View-specific actions; rendered only inside the actions zone. */
		actions?: Snippet;
		/** Optional secondary metadata row beneath the primary header line. */
		meta?: Snippet;
		/** Optional extra classes on the header element. */
		class?: string;
	}

	let {
		reference,
		title,
		titleTestid,
		statusDomain,
		statusState,
		statusTestid,
		counts = [],
		badges,
		actions,
		meta,
		class: className
	}: Props = $props();

	let copied = $state(false);

	// AC: @ui-view-header ac-1 — entity reference is copyable.
	async function copyReference() {
		try {
			await navigator.clipboard.writeText(reference);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 1500);
		} catch {
			// Clipboard unavailable (e.g. insecure context) — fail silently.
		}
	}
</script>

<header data-testid="view-header" class={cn('ds-view-header flex flex-col gap-2', className)}>
	<div class="flex items-center gap-3">
		<!--
			Leading chrome reservation. Intentionally empty: contains no header
			element, sized by the single named reservation value. (@ui-view-header ac-3)
		-->
		<div
			data-testid="view-header-leading"
			class="ds-view-header__leading shrink-0"
			style="inline-size: var(--ds-chrome-leading-reservation, 0px);"
			aria-hidden="true"
		></div>

		<div class="flex min-w-0 flex-1 items-center gap-3">
			<!-- Reference zone -->
			<div
				data-testid="view-header-reference"
				class="flex min-w-0 items-center gap-1.5"
			>
				{#if title}
					<span class="truncate font-semibold" data-testid={titleTestid ?? 'view-header-title'}
						>{title}</span
					>
				{/if}
				<span class="font-mono text-xs text-muted-foreground" data-testid="view-header-ref"
					>@{shortRef(reference)}</span
				>
				<button
					type="button"
					data-testid="view-header-copy"
					class="inline-flex size-5 shrink-0 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={copyReference}
					aria-label={`Copy reference ${reference}`}
				>
					<span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
				</button>
			</div>

			<!-- State zone -->
			{#if (statusDomain && statusState) || badges}
				<div class="flex items-center gap-1.5" data-testid="view-header-state-zone">
					{#if statusDomain && statusState}
						<StatusBadge domain={statusDomain} state={statusState} testid={statusTestid} />
					{/if}
					{@render badges?.()}
				</div>
			{/if}

			<!-- Counts zone -->
			{#if counts.length > 0}
				<div
					class="flex items-center gap-3 text-xs text-muted-foreground"
					data-testid="view-header-counts"
				>
					{#each counts as count (count.label)}
						<span data-testid={count.testid ?? 'view-header-count'}>
							<span class="font-medium text-foreground">{count.value}</span>
							{count.label}
						</span>
					{/each}
				</div>
			{/if}

			<div class="flex-1"></div>

			<!-- Actions zone — the only place view actions appear. -->
			<div
				class="ds-view-header__actions flex shrink-0 items-center gap-2"
				data-testid="view-header-actions"
			>
				{@render actions?.()}
			</div>
		</div>
	</div>

	{#if meta}
		<div
			class="flex flex-wrap items-center gap-4 text-sm text-muted-foreground"
			style="padding-inline-start: var(--ds-chrome-leading-reservation, 0px);"
			data-testid="view-header-meta"
		>
			{@render meta()}
		</div>
	{/if}
</header>
