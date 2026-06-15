/**
 * Actor Identity Classification
 *
 * Shared, dependency-light classifier that resolves a recorded actor string
 * to a canonical identity (human, agent, or unknown). Lives in the shared
 * package so the daemon identity endpoint, the read-time/write-time actor
 * normalization paths, and the web UI all consume one implementation rather
 * than reinventing recognition rules per surface.
 *
 * Recognition is a pure function of (string, config): the same input and the
 * same configuration always yield the same result, and no input ever throws.
 *
 * AC: @actor-identity-resolution ac-2 — agent variants resolve to canonical agent
 * AC: @actor-identity-resolution ac-3 — human variants resolve to the human identity
 * AC: @actor-identity-resolution ac-4 — unrecognized strings classify as unknown without failing
 * AC: @actor-identity-resolution ac-5 — classification is deterministic
 */

import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Kind of identity a recorded actor string resolves to.
 */
export type ActorKind = "human" | "agent" | "unknown";

/**
 * Result of classifying a recorded actor string.
 *
 * `canonicalId` is null only when `kind` is "unknown". `original` always
 * preserves the input string verbatim so callers can fall back to it for
 * display or audit without losing the historical value.
 */
export interface ClassifiedActor {
  kind: ActorKind;
  canonicalId: string | null;
  displayName: string;
  original: string;
}

/**
 * Zod schema for the configured human identity.
 *
 * `canonicalId` is the resolved author string (the value persisted on new
 * records). `aliases` carries explicit recorded spellings that are not
 * derivable from the canonical form by the algorithmic normalization rules.
 */
export const HumanIdentitySchema = z.object({
  canonicalId: z.string().min(1),
  displayName: z.string().min(1),
  aliases: z.array(z.string()).optional(),
});

export type HumanIdentity = z.infer<typeof HumanIdentitySchema>;

/**
 * Zod schema for a single canonical agent identity in the roster.
 */
export const AgentIdentitySchema = z.object({
  canonicalId: z.string().min(1),
  displayName: z.string().min(1),
  aliases: z.array(z.string()).optional(),
});

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/**
 * Zod schema for the identity configuration consumed by the classifier and
 * returned by the daemon identity endpoint (`GET /api/identity`). One bounded
 * object: the configured human identity (or null when none is configured) and
 * the canonical agent roster.
 *
 * AC: @actor-identity-resolution ac-1 — identity surface payload shape
 */
export const ActorIdentityConfigSchema = z.object({
  human: HumanIdentitySchema.nullable(),
  agents: z.array(AgentIdentitySchema),
});

export type ActorIdentityConfig = z.infer<typeof ActorIdentityConfigSchema>;

// ─── Variant recognition rules ────────────────────────────────────────────────

/**
 * Trailing role suffixes stripped when matching a recorded actor string to a
 * canonical identity (e.g. `codex-reviewer` → `codex`). These are generic
 * agent-role words, not project-specific identifiers; project-specific
 * non-derivable spellings belong in each identity's `aliases` list instead.
 *
 * Exact canonical/alias matches are always tried before suffix stripping, so
 * canonical ids that legitimately end in one of these suffixes
 * (e.g. `pr-reviewer`, `task-worker`) are matched whole and never truncated.
 */
const ROLE_SUFFIXES = ["reviewer", "worker", "agent", "bot"] as const;

/**
 * Normalize a token for case- and whitespace-insensitive comparison.
 */
function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Strip a single leading `@` from a normalized token, if present.
 */
function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Generate the ordered list of recognition candidate keys for an input string.
 *
 * The order encodes precedence: the most specific (exact) form first, then
 * progressively stripped forms. The classifier returns the first candidate
 * that matches a registered identity key, which guarantees that an exact
 * canonical match wins over a suffix-stripped one.
 *
 * Covers the recorded variant families measured in the actor-string
 * inventory: the canonical id itself, `@`-prefixed forms, email-suffixed
 * forms (`codex@openai.com`, `codex@local`, `codex@gpt-5`), and role-suffixed
 * forms (`codex-reviewer`).
 */
function recognitionCandidates(input: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  const base = normalizeToken(input);
  add(base);

  // `@codex` → `codex`
  const noAt = stripLeadingAt(base);
  add(noAt);

  // `codex@openai.com` → `codex`; `pr-reviewer@kspec` → `pr-reviewer`.
  // Applied to the `@`-stripped form so a leading-only `@` is already handled.
  const atIndex = noAt.indexOf("@");
  const emailLocal = atIndex > 0 ? noAt.slice(0, atIndex) : noAt;
  add(emailLocal);

  // `codex-reviewer` → `codex`. Strip from the email-local form so
  // `codex-reviewer@openai.com` also reduces correctly.
  for (const suffix of ROLE_SUFFIXES) {
    const dashSuffix = `-${suffix}`;
    if (emailLocal.endsWith(dashSuffix) && emailLocal.length > dashSuffix.length) {
      add(emailLocal.slice(0, -dashSuffix.length));
    }
  }

  return candidates;
}

interface RecognizedIdentity {
  kind: "human" | "agent";
  canonicalId: string;
  displayName: string;
}

/**
 * Compiled recognition table: normalized recognition key → identity.
 */
export interface ActorClassifier {
  (actorString: string): ClassifiedActor;
}

function addRecognitionKey(
  map: Map<string, RecognizedIdentity>,
  key: string,
  identity: RecognizedIdentity,
): void {
  const normalized = normalizeToken(key);
  if (!normalized) {
    return;
  }
  // First registration wins so classification stays deterministic on
  // collisions; the human identity is registered before agents (see
  // buildActorClassifier) and therefore takes precedence on a shared key.
  if (!map.has(normalized)) {
    map.set(normalized, identity);
  }
  const stripped = stripLeadingAt(normalized);
  if (stripped !== normalized && stripped && !map.has(stripped)) {
    map.set(stripped, identity);
  }
}

function registerIdentity(
  map: Map<string, RecognizedIdentity>,
  identity: RecognizedIdentity,
  aliases: string[] | undefined,
): void {
  addRecognitionKey(map, identity.canonicalId, identity);
  for (const alias of aliases ?? []) {
    addRecognitionKey(map, alias, identity);
  }
}

/**
 * Build the recognition table from an identity configuration.
 */
function buildRecognitionMap(config: ActorIdentityConfig): Map<string, RecognizedIdentity> {
  const map = new Map<string, RecognizedIdentity>();

  // Human registered first → wins ties on shared keys.
  if (config.human) {
    registerIdentity(
      map,
      {
        kind: "human",
        canonicalId: config.human.canonicalId,
        displayName: config.human.displayName,
      },
      config.human.aliases,
    );
  }

  for (const agent of config.agents) {
    registerIdentity(
      map,
      { kind: "agent", canonicalId: agent.canonicalId, displayName: agent.displayName },
      agent.aliases,
    );
  }

  return map;
}

function classifyWithMap(
  actorString: string,
  map: Map<string, RecognizedIdentity>,
): ClassifiedActor {
  // Never throw on malformed input — unknown is a valid read-side result.
  if (typeof actorString !== "string") {
    const original = (actorString ?? "") as string;
    return { kind: "unknown", canonicalId: null, displayName: original, original };
  }

  if (actorString.trim() === "") {
    return { kind: "unknown", canonicalId: null, displayName: actorString, original: actorString };
  }

  for (const candidate of recognitionCandidates(actorString)) {
    const hit = map.get(candidate);
    if (hit) {
      return {
        kind: hit.kind,
        canonicalId: hit.canonicalId,
        displayName: hit.displayName,
        original: actorString,
      };
    }
  }

  // Unrecognized: preserve the original string, classify as unknown.
  return {
    kind: "unknown",
    canonicalId: null,
    displayName: actorString,
    original: actorString,
  };
}

/**
 * Compile a reusable classifier for a fixed identity configuration.
 *
 * Use this when classifying many actor strings against one configuration
 * (e.g. the read-time/write-time normalization sweep over historical
 * records): the recognition table is built once and reused.
 *
 * AC: @actor-identity-resolution ac-5 — deterministic for a fixed config
 */
export function buildActorClassifier(config: ActorIdentityConfig): ActorClassifier {
  const map = buildRecognitionMap(config);
  return (actorString: string) => classifyWithMap(actorString, map);
}

/**
 * Classify a single recorded actor string against an identity configuration.
 *
 * Pure function of (string, config): same inputs → same output, never throws.
 *
 * AC: @actor-identity-resolution ac-2 — agent variant → canonical agent
 * AC: @actor-identity-resolution ac-3 — human variant → human identity
 * AC: @actor-identity-resolution ac-4 — unrecognized → unknown, original preserved
 * AC: @actor-identity-resolution ac-5 — deterministic
 */
export function classifyActor(actorString: string, config: ActorIdentityConfig): ClassifiedActor {
  return classifyWithMap(actorString, buildRecognitionMap(config));
}
