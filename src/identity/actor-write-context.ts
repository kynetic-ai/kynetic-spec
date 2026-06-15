/**
 * Context-aware Actor Write Resolution
 *
 * Convenience wrapper that builds the identity configuration from a loaded
 * `KspecContext` (config author/display/aliases + the project agent roster) and
 * resolves an actor value through the shared actor-write utility in one call.
 *
 * CLI commands and other non-daemon writers use this so they share the exact
 * same resolution + classification + rejection behavior as the daemon routes,
 * without each re-deriving the identity configuration.
 *
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 */

import type { KspecContext } from "../parser/yaml.js";
import { loadMetaContext } from "../parser/meta.js";
import { buildActorIdentityConfig } from "./actor-identity-config.js";
import { resolveActorForWrite, type ActorWriteResolution } from "./actor-write.js";

/**
 * Build the identity configuration for a project context: the configured human
 * identity (author precedence + display name + aliases) and the canonical agent
 * roster (with configured agent aliases).
 */
export async function buildIdentityConfigFromContext(ctx: KspecContext) {
  const meta = await loadMetaContext(ctx);
  return buildActorIdentityConfig({
    configAuthor: ctx.config?.identity?.author,
    displayName: ctx.config?.identity?.display_name,
    humanAliases: ctx.config?.identity?.aliases,
    agentAliases: ctx.config?.identity?.agent_aliases,
    agents: meta.agents,
  });
}

/**
 * Resolve and canonicalize an actor value for a write, deriving the identity
 * configuration from the given context.
 *
 * @param ctx     the loaded project context
 * @param options explicit caller value (may be undefined) and the actor field name
 */
export async function resolveActorForContext(
  ctx: KspecContext,
  options: { explicit?: string | null; field?: string } = {},
): Promise<ActorWriteResolution> {
  const identity = await buildIdentityConfigFromContext(ctx);
  return resolveActorForWrite({
    explicit: options.explicit,
    identity,
    configAuthor: ctx.config?.identity?.author,
    field: options.field,
  });
}
