<!--
  ActorDisplay — the single primitive for rendering a recorded actor.

  It classifies a recorded actor string through the shared classifier (fed by
  the identity endpoint payload) and renders the canonical display name with a
  visual distinction between human and agent kinds. Unknown actors render the
  original recorded string with a distinct unknown treatment and are never
  presented as a canonical identity. Because every surface composes this one
  component with the same classifier, the same actor renders identically
  wherever it appears.

  When no classifier is supplied (e.g. static export with no daemon identity
  surface, or before the identity payload loads) the actor degrades to the
  unknown treatment rather than being misattributed.

  Spec: @actor-display ac-1 (canonical name + human/agent distinction, stable),
        ac-2 (unknown treatment, never canonical)
-->
<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { ActorClassifier, ActorKind, ClassifiedActor } from '$lib/utils/actor';

	interface Props {
		/** The recorded actor string to render. */
		actor: string;
		/**
		 * Classifier built from the identity payload. When omitted, the actor is
		 * treated as unknown (static mode / identity unavailable).
		 */
		classifier?: ActorClassifier;
		/** Optional extra classes merged onto the root element. */
		class?: string;
		/** Optional test id forwarded to the root element. */
		testid?: string;
		/** Show the kind glyph (default true). */
		showGlyph?: boolean;
	}

	let { actor, classifier, class: className, testid, showGlyph = true }: Props = $props();

	// Degrade to unknown when no classifier is available so we never present an
	// unresolved string as a canonical identity.
	const unknownFallback = (value: string): ClassifiedActor => ({
		kind: 'unknown',
		canonicalId: null,
		displayName: value,
		original: value
	});

	let classified = $derived<ClassifiedActor>(
		classifier ? classifier(actor) : unknownFallback(actor)
	);

	// Visual + accessible distinction per kind. The glyph differs per kind, the
	// data-actor-kind attribute carries the machine-readable kind, and the
	// sr-only label names the kind for assistive technology.
	const KIND_META: Record<ActorKind, { glyph: string; label: string; nameClass: string }> = {
		human: { glyph: '◯', label: 'Human', nameClass: 'font-medium' },
		agent: { glyph: '⬢', label: 'Agent', nameClass: 'font-medium' },
		// Unknown: original string, distinctly muted/italic — not a canonical name.
		unknown: { glyph: '?', label: 'Unknown actor', nameClass: 'italic text-muted-foreground' }
	};

	let meta = $derived(KIND_META[classified.kind]);
	// For known actors show the canonical display name; for unknown actors show
	// the original recorded string verbatim.
	let shownName = $derived(
		classified.kind === 'unknown' ? classified.original : classified.displayName
	);
</script>

<span
	data-slot="actor-display"
	data-testid={testid}
	data-actor-kind={classified.kind}
	class={cn('inline-flex w-fit items-center gap-1 whitespace-nowrap', className)}
	title={classified.kind === 'unknown' ? `Unrecognized actor: ${classified.original}` : undefined}
>
	{#if showGlyph}
		<span aria-hidden="true" class="font-mono leading-none" data-actor-glyph>{meta.glyph}</span>
	{/if}
	<span class="sr-only" data-actor-kind-label>{meta.label}:</span>
	<span data-actor-name class={meta.nameClass}>{shownName}</span>
</span>
