/**
 * Actor identity utilities for the web UI.
 *
 * Thin re-export of the shared actor classifier so web components have a single
 * stable import site. The classifier is fed by the identity endpoint payload
 * (`fetchIdentity()` in `$lib/api`) in daemon mode and by the static snapshot
 * in read-only/static mode — the same pure function classifies recorded actor
 * strings in both.
 *
 * AC: @actor-identity-resolution ac-2, ac-3, ac-4, ac-5 — shared classifier
 *     consumed by the web UI
 */

export { classifyActor, buildActorClassifier } from "@kynetic-ai/shared";
export type {
  ActorKind,
  ClassifiedActor,
  HumanIdentity,
  AgentIdentity,
  ActorIdentityConfig,
  ActorClassifier,
} from "@kynetic-ai/shared";
