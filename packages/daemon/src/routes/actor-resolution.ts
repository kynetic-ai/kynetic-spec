/**
 * Daemon Actor Resolution Helper
 *
 * Thin daemon-route adapter over the shared actor-write utility
 * (`resolveActorForWrite` in core). Loads the project's identity configuration
 * (configured human + canonical agent roster) — preferring the warm meta cache,
 * falling back to a direct load — and resolves a write's actor value against it.
 *
 * Every review mutation route routes its author/actor/reviewer/runner value
 * through here so the daemon never persists an anonymous placeholder or a
 * non-canonical free-form actor.
 *
 * AC: @actor-identity-resolution ac-6 — absent value resolves through precedence, never anonymous
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 */

import {
  buildActorIdentityConfig,
  initContext,
  loadMetaContext,
  resolveActorForWrite,
  type ActorWriteResolution,
} from "../../parser/index.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

type InitializedContext = Awaited<ReturnType<typeof initContext>>;

/**
 * The validation-error body shape returned for a rejected actor write — matches
 * the daemon's `{ error, message, details:[{field,message}] }` contract.
 *
 * AC: @trait-api-endpoint ac-3 — 400 with structured validation details
 */
export interface ActorValidationErrorBody {
  error: "validation_error";
  message: string;
  details: Array<{ field: string; message: string }>;
}

/**
 * Build the project's identity configuration from context, preferring the warm
 * meta cache for the roster and falling back to a direct meta load.
 */
async function loadActorIdentityConfig(
  ctx: InitializedContext,
  getEntityCache: EntityCacheAccessor | undefined,
  projectPath: string,
) {
  const cache = getEntityCache?.(projectPath);
  let meta = cache?.getDomainState("meta") === "ready" ? cache.getMetaDetail() : null;
  if (!meta) {
    meta = await loadMetaContext(ctx);
  }
  return buildActorIdentityConfig({
    configAuthor: ctx.config?.identity?.author,
    displayName: ctx.config?.identity?.display_name,
    humanAliases: ctx.config?.identity?.aliases,
    agentAliases: ctx.config?.identity?.agent_aliases,
    agents: meta.agents,
  });
}

/**
 * Resolve and canonicalize an actor value for a daemon write. On success the
 * returned resolution carries the canonical `actor`; on failure it carries
 * structured validation feedback (see {@link toValidationErrorBody}).
 *
 * @param explicit the caller-supplied actor value (may be undefined/blank)
 * @param field    the actor field name, used in validation feedback
 */
export async function resolveWriteActor(
  ctx: InitializedContext,
  getEntityCache: EntityCacheAccessor | undefined,
  projectPath: string,
  explicit: string | null | undefined,
  field: string,
): Promise<ActorWriteResolution> {
  const identity = await loadActorIdentityConfig(ctx, getEntityCache, projectPath);
  return resolveActorForWrite({
    explicit,
    identity,
    configAuthor: ctx.config?.identity?.author,
    field,
  });
}

/**
 * Convert a rejected actor resolution into the daemon validation-error body.
 */
export function toValidationErrorBody(
  resolution: Extract<ActorWriteResolution, { ok: false }>,
): ActorValidationErrorBody {
  return {
    error: "validation_error",
    message: resolution.error.message,
    details: [{ field: resolution.error.field, message: resolution.error.message }],
  };
}
