/**
 * Actor Write Utility — behavioral tests.
 *
 * Exercises the single shared actor-write utility that every actor-bearing
 * write path funnels through: resolution through the author precedence chain,
 * canonicalization via the shared classifier, and rejection of out-of-pool /
 * anonymous values with structured validation feedback.
 *
 * AC: @actor-identity-resolution ac-6 — absent value resolves through precedence, never anonymous
 * AC: @actor-identity-resolution ac-7 — recognized variant persists as the canonical id
 * AC: @actor-identity-resolution ac-8 — out-of-pool value rejected with validation feedback
 * AC: @actor-identity-model ac-1 — new actor-bearing writes are canonical or rejected
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorIdentityConfig } from "@kynetic-ai/shared";
import { resolveActorForWrite } from "../src/identity/actor-write.js";
import { buildActorIdentityConfig } from "../src/identity/actor-identity-config.js";

const POOL: ActorIdentityConfig = {
  human: { canonicalId: "@jacob", displayName: "Jacob Chapel", aliases: ["Jacob Chapel"] },
  agents: [
    { canonicalId: "codex", displayName: "Codex" },
    { canonicalId: "pr-reviewer", displayName: "PR Reviewer", aliases: ["@dispatch"] },
  ],
};

let savedAuthor: string | undefined;

beforeEach(() => {
  savedAuthor = process.env.KSPEC_AUTHOR;
});

afterEach(() => {
  if (savedAuthor === undefined) {
    delete process.env.KSPEC_AUTHOR;
  } else {
    process.env.KSPEC_AUTHOR = savedAuthor;
  }
});

describe("resolveActorForWrite", () => {
  // AC: @actor-identity-resolution ac-7 — agent email-suffix variant → canonical agent id
  it("canonicalizes an explicit agent email variant to the agent id", () => {
    const result = resolveActorForWrite({ explicit: "codex@openai.com", identity: POOL });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toBe("codex");
    }
  });

  // AC: @actor-identity-resolution ac-7 — at-prefixed agent variant resolves to canonical id
  it("canonicalizes an @-prefixed agent variant to the agent id", () => {
    const result = resolveActorForWrite({ explicit: "@codex", identity: POOL });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actor).toBe("codex");
  });

  // AC: @actor-identity-resolution ac-7 — configured agent alias → canonical id
  it("canonicalizes a configured agent alias to the agent id", () => {
    const result = resolveActorForWrite({ explicit: "@dispatch", identity: POOL });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actor).toBe("pr-reviewer");
  });

  // AC: @actor-identity-resolution ac-7 — human variant (alias) → canonical human id
  it("canonicalizes a human variant to the configured human id", () => {
    const result = resolveActorForWrite({ explicit: "Jacob Chapel", identity: POOL });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actor).toBe("@jacob");
  });

  // AC: @actor-identity-resolution ac-7 — already-canonical value is preserved
  it("keeps an already-canonical identity unchanged", () => {
    expect(resolveActorForWrite({ explicit: "@jacob", identity: POOL })).toMatchObject({
      ok: true,
      actor: "@jacob",
    });
    expect(resolveActorForWrite({ explicit: "pr-reviewer", identity: POOL })).toMatchObject({
      ok: true,
      actor: "pr-reviewer",
    });
  });

  // AC: @actor-identity-resolution ac-8 — the "anonymous" placeholder is rejected
  it("rejects the anonymous placeholder instead of persisting it", () => {
    const result = resolveActorForWrite({ explicit: "anonymous", identity: POOL, field: "author" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("out_of_pool");
      expect(result.error.field).toBe("author");
      expect(result.error.original).toBe("anonymous");
      expect(result.error.message).toMatch(/not a configured human or agent identity/i);
    }
  });

  // AC: @actor-identity-resolution ac-8 — an unrecognizable value is rejected with feedback
  it("rejects an unrecognizable actor value with structured feedback", () => {
    const result = resolveActorForWrite({
      explicit: "randomdude",
      identity: POOL,
      field: "reviewer",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("out_of_pool");
      expect(result.error.field).toBe("reviewer");
      expect(result.error.pool.human).toBe("@jacob");
      expect(result.error.pool.agents).toEqual(["codex", "pr-reviewer"]);
    }
  });

  // AC: @actor-identity-resolution ac-6 — absent value resolves through the chain, never anonymous
  it("resolves an absent value through the author precedence chain", () => {
    process.env.KSPEC_AUTHOR = "@jacob";
    const result = resolveActorForWrite({ explicit: undefined, identity: POOL });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toBe("@jacob");
      expect(result.actor).not.toBe("anonymous");
    }
  });

  // AC: @actor-identity-resolution ac-6 — a blank explicit value is treated as absent
  it("treats a blank explicit value as absent and resolves through the chain", () => {
    process.env.KSPEC_AUTHOR = "codex@openai.com";
    const result = resolveActorForWrite({ explicit: "   ", identity: POOL });
    expect(result.ok).toBe(true);
    // The chain value is itself classified, so a variant resolves to canonical.
    if (result.ok) expect(result.actor).toBe("codex");
  });

  // AC: @actor-identity-model ac-1 — with no resolvable author, the write is rejected, not anonymous
  it("rejects when no actor can be resolved at all", () => {
    delete process.env.KSPEC_AUTHOR;
    const emptyPool: ActorIdentityConfig = { human: null, agents: [] };
    const result = resolveActorForWrite({
      explicit: undefined,
      identity: emptyPool,
      configAuthor: null,
    });
    // Either unresolved (no chain value) or out_of_pool (chain value not configured) —
    // never a silent anonymous placeholder.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["unresolved", "out_of_pool"]).toContain(result.error.reason);
    }
  });
});

describe("buildActorIdentityConfig", () => {
  // AC: @actor-identity-resolution ac-1 — human identity (with display) + agent roster
  it("builds the human identity and agent roster with aliases", () => {
    process.env.KSPEC_AUTHOR = "@jacob";
    const config = buildActorIdentityConfig({
      configAuthor: "@jacob",
      displayName: "Jacob Chapel",
      humanAliases: ["jchapel"],
      agentAliases: { codex: ["claude-codex"] },
      agents: [
        { id: "codex", name: "Codex" },
        { id: "pr-reviewer", name: "PR Reviewer" },
      ],
    });
    expect(config.human).toMatchObject({ canonicalId: "@jacob", displayName: "Jacob Chapel" });
    expect(config.human?.aliases).toEqual(["jchapel"]);
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]).toMatchObject({ canonicalId: "codex", displayName: "Codex" });
    expect(config.agents[0].aliases).toEqual(["claude-codex"]);
  });

  // AC: @actor-identity-resolution ac-7 — a config built this way canonicalizes agent variants
  it("produces a config the write utility uses to canonicalize variants", () => {
    process.env.KSPEC_AUTHOR = "@jacob";
    const config = buildActorIdentityConfig({
      configAuthor: "@jacob",
      agents: [{ id: "codex", name: "Codex" }],
      agentAliases: { codex: ["claude-codex"] },
    });
    expect(resolveActorForWrite({ explicit: "claude-codex", identity: config })).toMatchObject({
      ok: true,
      actor: "codex",
    });
  });
});
