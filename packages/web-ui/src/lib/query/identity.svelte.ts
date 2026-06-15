/**
 * Identity classifier hook.
 *
 * Fetches the project's identity configuration once (shared, deduped by query
 * key across every consumer) and compiles it into a reactive actor classifier.
 * Pages call this once and thread the resulting classifier into the
 * `ActorDisplay` primitive so the whole view classifies recorded actor strings
 * against one identity payload.
 *
 * In static mode (or before the identity payload loads, or on error) the
 * classifier is `undefined`; `ActorDisplay` degrades to the unknown treatment
 * in that case rather than misattributing actors.
 *
 * AC: @actor-display ac-1 — same actor renders identically (one shared payload)
 * AC: @actor-display ac-2 — unknown degradation when identity is unavailable
 */

import { createQuery } from "$lib/query/createQuery.svelte.js";
import { queryKeys } from "$lib/query/keys.js";
import { fetchIdentity } from "$lib/api";
import { isInitialized as isProjectInitialized } from "$lib/stores/project.svelte";
import { buildActorClassifier, type ActorClassifier } from "$lib/utils/actor";

/**
 * Reactive accessor returning the compiled classifier, or `undefined` while the
 * identity payload is unavailable.
 */
export interface ActorClassifierHandle {
  readonly classifier: ActorClassifier | undefined;
}

/**
 * Create a reactive actor classifier backed by the identity query.
 *
 * Must be called during component initialization (it uses the query runes).
 */
export function createActorClassifier(): ActorClassifierHandle {
  const identityQuery = createQuery(() => ({
    queryKey: queryKeys.identity.config(),
    queryFn: () => fetchIdentity(),
    enabled: isProjectInitialized(),
    // Identity changes rarely; keep it warm to avoid refetch churn while many
    // ActorDisplay instances mount.
    staleTime: 5 * 60 * 1000,
  }));

  // Rebuild the recognition table only when the payload identity changes.
  const classifier = $derived(
    identityQuery.data ? buildActorClassifier(identityQuery.data) : undefined,
  );

  return {
    get classifier() {
      return classifier;
    },
  };
}
