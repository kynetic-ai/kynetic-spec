<!--
  Adaptive breadcrumb trail.

  Renders the server-resolved ancestor chain (root → current entity) with
  count-driven truncation tiers and width-driven overflow collapse. Collapsed
  segments stay reachable through an overlay popover that lists them in
  hierarchy order with click/tap/keyboard activation.

  AC: @ui-breadcrumb ac-1 — ≤4 segments render in full, no collapse indicator
  AC: @ui-breadcrumb ac-2 — 5–6 segments: root + indicator + last two + current
  AC: @ui-breadcrumb ac-3 — 7+ segments: root + indicator + last one + current
  AC: @ui-breadcrumb ac-4 — width overflow folds visible ancestors (root included) away
  AC: @ui-breadcrumb ac-5 — collapse indicator opens a popover of collapsed segments as links
  AC: @ui-breadcrumb ac-6 — popover keyboard nav: up/down move, Enter navigates, Escape closes
  AC: @ui-breadcrumb ac-7 — indicator opens by click/tap/keyboard, never hover-only
  AC: @ui-breadcrumb ac-8 — popover is an overlay, so opening/closing shifts nothing
  AC: @ui-breadcrumb ac-9 — each segment carries its kind indicator; current is emphasized
  AC: @ui-breadcrumb ac-10 — consumes server-resolved ancestors; issues no client list fetch
-->
<script lang="ts">
	import type { BreadcrumbAncestor } from '@kynetic-ai/shared';
	import { Popover } from 'bits-ui';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import { cn } from '$lib/utils.js';
	import { refHref, shortRef } from '$lib/utils/reference';
	import { kindMeta } from '$lib/utils/breadcrumb-kind';
	import {
		computeTrail,
		canCollapseFurther,
		nextPopoverIndex
	} from '$lib/utils/breadcrumb-trail';

	interface Props {
		/** Server-resolved ancestor chain, root → current entity. */
		ancestors: BreadcrumbAncestor[];
		/** Additional classes for the wrapping <nav>. */
		class?: string;
	}

	let { ancestors, class: className = '' }: Props = $props();

	let containerEl = $state<HTMLElement>();
	let overflowLevel = $state(0);

	// Re-expand to the count tier whenever the chain changes; the overflow
	// effect below collapses back down if it still doesn't fit.
	$effect(() => {
		void ancestors;
		overflowLevel = 0;
	});

	let trail = $derived(computeTrail(ancestors, overflowLevel));

	// AC: @ui-breadcrumb ac-4 — measure rendered width and fold one more ancestor
	// away while the trail overflows and an ancestor remains to collapse.
	$effect(() => {
		// Track the trail so this re-runs after each collapse step re-renders.
		void trail;
		if (!containerEl) return;
		const overflowing = containerEl.scrollWidth > containerEl.clientWidth + 1;
		if (overflowing && canCollapseFurther(trail)) {
			overflowLevel += 1;
		}
	});

	// Re-expand on container resize so a widening viewport restores segments.
	$effect(() => {
		if (!containerEl || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			overflowLevel = 0;
		});
		observer.observe(containerEl);
		return () => observer.disconnect();
	});

	function segmentHref(seg: BreadcrumbAncestor): string {
		return refHref(kindMeta(seg.kind).refType, seg.ref, base);
	}

	function segmentLabel(seg: BreadcrumbAncestor): string {
		return seg.title ?? shortRef(seg.ref);
	}

	// ── Popover keyboard navigation (AC: @ui-breadcrumb ac-6) ──────────────────
	let popoverOpen = $state(false);
	let selectedIndex = $state(-1);
	let rowEls = $state<HTMLAnchorElement[]>([]);

	$effect(() => {
		if (!popoverOpen) selectedIndex = -1;
	});

	function focusSelected() {
		const el = rowEls[selectedIndex];
		if (el) el.focus();
	}

	function onPopoverKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = nextPopoverIndex(selectedIndex, event.key, trail.collapsed.length);
			focusSelected();
		} else if (event.key === 'Enter' && selectedIndex >= 0) {
			event.preventDefault();
			const seg = trail.collapsed[selectedIndex];
			if (seg) {
				popoverOpen = false;
				goto(segmentHref(seg));
			}
		}
		// Escape is handled by the popover primitive, which closes without navigating.
	}
</script>

{#snippet kindPill(seg: BreadcrumbAncestor)}
	{@const meta = kindMeta(seg.kind)}
	<span
		class={cn('rounded px-1.5 py-0.5 text-[10px] font-medium leading-none', meta.pillClass)}
		data-testid="breadcrumb-kind"
		data-kind={seg.kind}
	>
		{meta.label}
	</span>
{/snippet}

{#snippet separator()}
	<ChevronRight class="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
{/snippet}

<nav
	aria-label="Breadcrumb"
	class={cn('min-w-0', className)}
	data-testid="breadcrumb"
	data-segment-count={ancestors.length}
>
	<ol
		bind:this={containerEl}
		class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm"
	>
		{#each trail.leading as seg (seg.ref)}
			<li class="flex shrink-0 items-center gap-1.5">
				<a
					href={segmentHref(seg)}
					class="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-testid="breadcrumb-segment"
				>
					{@render kindPill(seg)}
					<span class="truncate">{segmentLabel(seg)}</span>
				</a>
			</li>
			<li aria-hidden="true" class="flex shrink-0 items-center">{@render separator()}</li>
		{/each}

		{#if trail.hasCollapse}
			<li class="flex shrink-0 items-center">
				<Popover.Root bind:open={popoverOpen}>
					<!-- AC: @ui-breadcrumb ac-7 — trigger is a button: click, tap, and keyboard all open it; never hover-only -->
					<Popover.Trigger
						class="flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="breadcrumb-collapse"
						aria-label="Show {trail.collapsed.length} collapsed breadcrumb segments"
					>
						<span aria-hidden="true">…</span>
						<span class="font-mono text-[10px] opacity-70">{trail.collapsed.length}</span>
					</Popover.Trigger>
					<!-- AC: @ui-breadcrumb ac-8 — Content renders in a portal overlay, so opening shifts no surrounding content -->
					<Popover.Portal>
						<Popover.Content
							class="z-50 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
							sideOffset={6}
							align="start"
						>
							<!-- AC: @ui-breadcrumb ac-5, ac-6 — collapsed segments in hierarchy order; keyboard-navigable -->
							<ul
								class="flex flex-col gap-0.5"
								data-testid="breadcrumb-popover"
								onkeydown={onPopoverKeydown}
							>
								{#each trail.collapsed as seg, i (seg.ref)}
									<li>
										<a
											bind:this={rowEls[i]}
											href={segmentHref(seg)}
											class={cn(
												'flex items-center gap-1.5 rounded px-2 py-1 text-sm text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
												selectedIndex === i && 'bg-accent'
											)}
											data-testid="breadcrumb-popover-item"
											onclick={() => (popoverOpen = false)}
										>
											{@render kindPill(seg)}
											<span class="truncate">{segmentLabel(seg)}</span>
										</a>
									</li>
								{/each}
							</ul>
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			</li>
			<li aria-hidden="true" class="flex shrink-0 items-center">{@render separator()}</li>
		{/if}

		{#each trail.trailing as seg (seg.ref)}
			<li class="flex shrink-0 items-center gap-1.5">
				<a
					href={segmentHref(seg)}
					class="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-testid="breadcrumb-segment"
				>
					{@render kindPill(seg)}
					<span class="truncate">{segmentLabel(seg)}</span>
				</a>
			</li>
			<li aria-hidden="true" class="flex shrink-0 items-center">{@render separator()}</li>
		{/each}

		{#if trail.current}
			<!-- AC: @ui-breadcrumb ac-9 — current segment emphasized relative to ancestors -->
			<li class="flex min-w-0 items-center gap-1.5">
				<span
					class="flex min-w-0 items-center gap-1.5 font-semibold text-foreground"
					data-testid="breadcrumb-current"
					aria-current="page"
				>
					{@render kindPill(trail.current)}
					<span class="truncate">{segmentLabel(trail.current)}</span>
				</span>
			</li>
		{/if}
	</ol>
</nav>
