/**
 * Identity API Route
 *
 * GET /api/identity — exposes the project's identity configuration in a single
 * bounded response: the configured human identity (resolved through the author
 * precedence chain, plus any configured profile display name) and the canonical
 * agent roster built from the project's agent definitions. No entity-list
 * fan-out; the payload is the classifier configuration consumed by the daemon,
 * the web UI, and the actor-normalization paths.
 *
 * AC Coverage:
 * - @actor-identity-resolution ac-1: bounded identity surface (human + roster)
 * - @trait-api-endpoint ac-1: 2xx with JSON body
 * - @trait-api-endpoint ac-6: X-Request-Id header for tracing
 */

import { Elysia } from "elysia";
import { ulid } from "ulidx";
import { getAuthor, initContext, loadMetaContext } from "../../parser/index.js";
import type { ActorIdentityConfig, AgentIdentity, HumanIdentity } from "@kynetic-ai/shared";
import { wrapResponse } from "./response-envelope.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface IdentityRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

/**
 * Build the human identity from resolved config. Returns null when no author
 * can be resolved (no env var, no config author, no git/OS fallback) — the
 * identity surface then reports an empty human identity rather than inventing
 * one.
 *
 * AC: @actor-identity-resolution ac-1 — human identity with display name
 */
function buildHumanIdentity(
  configAuthor: string | null | undefined,
  displayName: string | null | undefined,
  aliases: string[] | undefined,
): HumanIdentity | null {
  const author = getAuthor(configAuthor ?? undefined);
  if (!author) {
    return null;
  }
  const identity: HumanIdentity = {
    canonicalId: author,
    displayName: displayName ?? author,
  };
  if (aliases && aliases.length > 0) {
    identity.aliases = aliases;
  }
  return identity;
}

export function createIdentityRoutes(options: IdentityRouteOptions = {}) {
  const { getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/identity" })
      // AC: @trait-api-endpoint ac-6 — X-Request-Id header on all responses.
      // Set in onTransform so it appears even on error responses, mirroring the
      // command route's request-id contract.
      .onTransform(({ set }) => {
        set.headers["X-Request-Id"] = ulid();
      })
      // AC: @actor-identity-resolution ac-1 — single bounded identity payload
      // AC: @trait-api-endpoint ac-1 — 2xx JSON body
      .get("/", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — report loading state
        // with an empty-but-shaped payload rather than blocking the request.
        if (cache && metaDomainState === "loading") {
          const loadingPayload: ActorIdentityConfig = { human: null, agents: [] };
          return wrapResponse(loadingPayload, { cacheDomainState: "loading" });
        }

        // initContext is needed for the resolved config (author precedence +
        // display name). syncMode "skip" keeps this off the shadow-sync path.
        // AC: @daemon-read-path ac-no-per-request-sync — no shadow sync on read
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });

        // AC: @daemon-entity-cache ac-serve-from-memory — prefer the cached meta
        // detail for the roster when warm; fall back to a direct load otherwise.
        let meta;
        if (cache && metaDomainState === "ready") {
          meta = cache.getMetaDetail();
        }
        if (!meta) {
          meta = await loadMetaContext(ctx);
        }

        const human = buildHumanIdentity(
          ctx.config?.identity?.author,
          ctx.config?.identity?.display_name,
          ctx.config?.identity?.aliases,
        );

        // AC: @actor-identity-resolution ac-1 — canonical agent roster: each
        // agent's canonical id and display information, no entity-list fan-out.
        const agents: AgentIdentity[] = meta.agents.map((agent) => ({
          canonicalId: agent.id,
          displayName: agent.name,
        }));

        const payload: ActorIdentityConfig = { human, agents };
        return wrapResponse(payload, { cacheDomainState: metaDomainState });
      })
  );
}
