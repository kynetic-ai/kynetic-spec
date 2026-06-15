/**
 * Actor Write Utility
 *
 * The single sanctioned path for resolving and canonicalizing an actor-bearing
 * value before it is persisted by any first-party write interface (daemon
 * routes, CLI commands, import/update helpers). Its contract:
 *
 *   1. Resolve an absent value through the configured author precedence chain
 *      (`@config-author`: env → config author → git → OS user).
 *   2. Classify the resolved value through the shared classifier
 *      (`@kynetic-ai/shared`) against the configured human/agent pool.
 *   3. Persist the canonical identity whenever classification resolves it —
 *      never the recorded variant form.
 *   4. Reject values that classify to no configured identity (including the
 *      historical `"anonymous"` placeholder) with structured validation
 *      feedback, instead of persisting a new free-form author.
 *
 * No route, CLI command, importer, or lower-level mutation helper may implement
 * its own author fallback or canonicalization logic. They pass their write
 * context through this utility before the value reaches storage.
 *
 * This is a write-path-only concern: historical/externally-edited records keep
 * their original values and are reconciled separately by the data upgrade path.
 *
 * AC: @actor-identity-resolution ac-6 — absent daemon-review value resolves through
 *     precedence, never an anonymous placeholder
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as the canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 * AC: @actor-identity-model ac-1 — new actor-bearing writes are canonical or rejected
 */

import { classifyActor, type ActorIdentityConfig, type ClassifiedActor } from "@kynetic-ai/shared";
import { getAuthor } from "../parser/yaml.js";

/**
 * The configured author pool, surfaced in validation feedback so callers can
 * report the acceptable identities.
 */
export interface ActorPool {
  human: string | null;
  agents: string[];
}

/**
 * Structured validation feedback for a rejected actor write. Shaped to map
 * directly onto the daemon's `{ field, message }` validation-detail contract.
 */
export interface ActorWriteValidationError {
  /** The actor field name (e.g. `"author"`, `"actor"`, `"reviewer"`). */
  field: string;
  /** Operator-facing explanation of why the value was rejected. */
  message: string;
  /** The value that failed resolution/classification (null when nothing resolved). */
  original: string | null;
  /** Reason discriminator for structured callers. */
  reason: "unresolved" | "out_of_pool";
  /** The configured identities the value was checked against. */
  pool: ActorPool;
}

/**
 * Result of resolving an actor value for a write. On success, `actor` is the
 * canonical identity to persist. On failure, `error` carries validation
 * feedback and nothing should be written.
 */
export type ActorWriteResolution =
  | { ok: true; actor: string; classification: ClassifiedActor }
  | { ok: false; error: ActorWriteValidationError };

/**
 * Options for {@link resolveActorForWrite}.
 */
export interface ResolveActorOptions {
  /**
   * The explicit caller-supplied actor value, if any (e.g. `body.author`,
   * `options.reviewer`). When absent or blank, the value is resolved through
   * the author precedence chain instead.
   */
  explicit?: string | null;
  /** The resolved identity configuration: configured human + agent roster. */
  identity: ActorIdentityConfig;
  /**
   * The project config author (`config.identity.author`) used as the chain
   * input when no explicit value is supplied. Defaults to the configured human
   * identity's canonical id, which is itself the chain result, so the fallback
   * stays consistent with the configured pool.
   */
  configAuthor?: string | null;
  /** The actor field name, used in validation feedback. Defaults to `"author"`. */
  field?: string;
}

function poolOf(identity: ActorIdentityConfig): ActorPool {
  return {
    human: identity.human?.canonicalId ?? null,
    agents: identity.agents.map((agent) => agent.canonicalId),
  };
}

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Resolve and canonicalize an actor value for persistence.
 *
 * Resolution order:
 *   - An explicit, non-blank caller value is used as-is (then classified).
 *   - Otherwise the value is resolved through the author precedence chain.
 *
 * The resolved value is classified against the configured pool. A value that
 * classifies to a configured human or agent identity is returned in canonical
 * form; a value that classifies to nothing (or that does not resolve at all) is
 * rejected with structured validation feedback.
 *
 * AC: @actor-identity-resolution ac-6 — absent value → precedence chain, never anonymous
 * AC: @actor-identity-resolution ac-7 — recognized variant → canonical id
 * AC: @actor-identity-resolution ac-8 — unrecognized value → rejected with feedback
 */
export function resolveActorForWrite(options: ResolveActorOptions): ActorWriteResolution {
  const field = options.field ?? "author";
  const pool = poolOf(options.identity);

  // Resolve the raw value: explicit caller value, else the author precedence
  // chain. The chain input prefers the explicit configAuthor, falling back to
  // the configured human canonical id (which is itself the chain result), so an
  // absent value resolves to the same identity the pool was built from.
  const chainAuthor = options.configAuthor ?? options.identity.human?.canonicalId ?? undefined;
  const raw = isBlank(options.explicit) ? getAuthor(chainAuthor) : (options.explicit as string);

  if (isBlank(raw)) {
    return {
      ok: false,
      error: {
        field,
        reason: "unresolved",
        message:
          `Could not resolve an actor for ${field}: no explicit value was supplied and the ` +
          `author precedence chain (env → config → git → OS user) yielded nothing. ` +
          `Configure an author identity or supply an explicit ${field}.`,
        original: typeof raw === "string" ? raw : null,
        pool,
      },
    };
  }

  const value = raw as string;
  const classification = classifyActor(value, options.identity);

  if (classification.kind === "unknown" || classification.canonicalId === null) {
    const agentHint =
      pool.agents.length > 0 ? ` or one of the configured agents: ${pool.agents.join(", ")}.` : `.`;
    return {
      ok: false,
      error: {
        field,
        reason: "out_of_pool",
        message: `"${value}" is not a configured human or agent identity and cannot be persisted as ${field}. Use the configured human identity${agentHint}`,
        original: value,
        pool,
      },
    };
  }

  // AC: @actor-identity-resolution ac-7 — store the canonical id, never the variant.
  return { ok: true, actor: classification.canonicalId, classification };
}
