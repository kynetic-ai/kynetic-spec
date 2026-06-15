/**
 * Actor Identity Configuration Builder
 *
 * Builds the `ActorIdentityConfig` (configured human identity + canonical agent
 * roster) consumed by the shared actor classifier. This is the single place
 * that turns project context — the author-precedence chain, the configured
 * display name/aliases, and the agent roster — into the classifier
 * configuration, so the daemon identity route, the actor-write utility, and any
 * other surface all resolve identities against the same data.
 *
 * Lives in core (not in a route or in the shared package) because building the
 * config requires the `getAuthor()` precedence chain, which is core code. The
 * resulting `ActorIdentityConfig` is the browser-safe classifier input from
 * `@kynetic-ai/shared`.
 *
 * AC: @actor-identity-resolution ac-1 — human identity (with display name) + roster
 * AC: @actor-identity-resolution ac-2 — agent aliases attached for variant resolution
 * AC: @actor-identity-resolution ac-3 — human aliases attached for variant resolution
 */

import type { ActorIdentityConfig, AgentIdentity, HumanIdentity } from "@kynetic-ai/shared";
import { getAuthor } from "../parser/yaml.js";

/**
 * A roster agent reduced to the fields the identity config needs: the canonical
 * id and the display name. Accepts any object with `id`/`name` so callers can
 * pass `LoadedAgent` (or any agent-shaped record) without coupling to its full
 * shape.
 */
export interface IdentityRosterAgent {
  id: string;
  name: string;
}

/**
 * Inputs for building an `ActorIdentityConfig`. All identity-config fields are
 * optional so an unconfigured project still produces a valid (git/OS-derived)
 * human identity and an empty alias set.
 */
export interface ActorIdentityConfigInput {
  /** `config.identity.author` — the project-level default author override. */
  configAuthor?: string | null;
  /** `config.identity.display_name` — human display name, falls back to the author. */
  displayName?: string | null;
  /** `config.identity.aliases` — non-derivable spellings of the human identity. */
  humanAliases?: string[];
  /** `config.identity.agent_aliases` — agent id → non-derivable spellings. */
  agentAliases?: Record<string, string[]>;
  /** The project's agent roster (e.g. `meta.agents`). */
  agents: IdentityRosterAgent[];
}

/**
 * Build the configured human identity from the resolved author precedence
 * chain. Returns `null` when no author can be resolved (no env var, no config
 * author, no git/OS fallback) — callers then treat the human pool as empty
 * rather than inventing an identity.
 *
 * AC: @actor-identity-resolution ac-1 — human identity carries a display name
 * AC: @config-author ac-1 ac-2 ac-3 — author resolved through the precedence chain
 */
export function buildHumanIdentity(
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

/**
 * Build the canonical agent roster: each agent's canonical id and display
 * information, with any configured non-derivable spellings attached as aliases
 * so the classifier can resolve measured variants the algorithmic rules cannot
 * derive from the id alone (e.g. `@dispatch` → `pr-reviewer`).
 *
 * AC: @actor-identity-resolution ac-2 — agent aliases attached for variant resolution
 */
export function buildAgentRoster(
  agents: IdentityRosterAgent[],
  agentAliases: Record<string, string[]> | undefined,
): AgentIdentity[] {
  const aliasMap = agentAliases ?? {};
  return agents.map((agent) => {
    const aliases = aliasMap[agent.id];
    const identity: AgentIdentity = {
      canonicalId: agent.id,
      displayName: agent.name,
    };
    if (aliases && aliases.length > 0) {
      identity.aliases = aliases;
    }
    return identity;
  });
}

/**
 * Build the full `ActorIdentityConfig` (human identity + agent roster) from
 * project context. This is the single sanctioned constructor for the
 * classifier configuration; the daemon identity route and the actor-write
 * utility both call it so identity resolution is uniform across read and write
 * surfaces.
 *
 * AC: @actor-identity-resolution ac-1 — single bounded identity configuration
 */
export function buildActorIdentityConfig(input: ActorIdentityConfigInput): ActorIdentityConfig {
  return {
    human: buildHumanIdentity(input.configAuthor, input.displayName, input.humanAliases),
    agents: buildAgentRoster(input.agents, input.agentAliases),
  };
}
