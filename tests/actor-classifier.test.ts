/**
 * Actor classifier behavioral tests.
 *
 * The variant corpus is seeded from the measured actor-string inventory in
 * plans/ui-redesign/analysis.md §4.6: the same codex agent recorded ≥7 ways
 * (`codex`, `codex@openai.com`, `codex@openai`, `codex@local`, `codex@gpt-5`,
 * `@codex`, `codex-reviewer`), pr-reviewer recorded 4 ways
 * (`pr-reviewer`, `@dispatch`, `@kspec`, `@kspec-dispatch`), the human author
 * (`Jacob Chapel`), and unrecognized strings (`Test User`, `Hermes`).
 */

import { describe, it, expect } from "vitest";
import {
  classifyActor,
  buildActorClassifier,
  type ActorIdentityConfig,
} from "../packages/shared/src/actor.ts";

const CONFIG: ActorIdentityConfig = {
  human: {
    canonicalId: "Jacob Chapel",
    displayName: "Jacob Chapel",
  },
  agents: [
    { canonicalId: "codex", displayName: "Codex" },
    {
      canonicalId: "pr-reviewer",
      displayName: "PR Reviewer",
      // Non-derivable historical spellings carried as explicit aliases.
      aliases: ["@dispatch", "@kspec", "@kspec-dispatch"],
    },
    { canonicalId: "claude", displayName: "Claude" },
    { canonicalId: "task-worker", displayName: "Task Worker" },
  ],
};

describe("classifyActor — agent variants (ac-2)", () => {
  // AC: @actor-identity-resolution ac-2 — recognizable agent variants resolve
  // to the canonical agent identity with kind "agent".
  const codexVariants = [
    "codex",
    "codex@openai.com",
    "codex@openai",
    "codex@local",
    "codex@gpt-5",
    "@codex",
    "codex-reviewer",
  ];

  for (const variant of codexVariants) {
    it(`resolves "${variant}" to the canonical codex agent`, () => {
      const result = classifyActor(variant, CONFIG);
      expect(result.kind).toBe("agent");
      expect(result.canonicalId).toBe("codex");
      expect(result.displayName).toBe("Codex");
      expect(result.original).toBe(variant);
    });
  }

  it("resolves case-insensitively", () => {
    // AC: @actor-identity-resolution ac-2
    const result = classifyActor("CODEX@OpenAI.com", CONFIG);
    expect(result.kind).toBe("agent");
    expect(result.canonicalId).toBe("codex");
    expect(result.original).toBe("CODEX@OpenAI.com");
  });

  it("resolves explicit non-derivable aliases to pr-reviewer", () => {
    // AC: @actor-identity-resolution ac-2
    for (const alias of ["@dispatch", "@kspec", "@kspec-dispatch", "dispatch"]) {
      const result = classifyActor(alias, CONFIG);
      expect(result.kind).toBe("agent");
      expect(result.canonicalId).toBe("pr-reviewer");
    }
  });

  it("strips an email suffix from an agent id (pr-reviewer@kspec)", () => {
    // AC: @actor-identity-resolution ac-2
    const result = classifyActor("pr-reviewer@kspec", CONFIG);
    expect(result.kind).toBe("agent");
    expect(result.canonicalId).toBe("pr-reviewer");
  });

  it("does not mangle canonical ids that end in a role suffix", () => {
    // AC: @actor-identity-resolution ac-2 — exact match wins over suffix stripping
    expect(classifyActor("pr-reviewer", CONFIG).canonicalId).toBe("pr-reviewer");
    expect(classifyActor("task-worker", CONFIG).canonicalId).toBe("task-worker");
  });

  it("classifies @claude as the claude agent", () => {
    // AC: @actor-identity-resolution ac-2
    expect(classifyActor("@claude", CONFIG).canonicalId).toBe("claude");
    expect(classifyActor("claude", CONFIG).canonicalId).toBe("claude");
  });
});

describe("classifyActor — human variants (ac-3)", () => {
  it("resolves the exact configured human identity", () => {
    // AC: @actor-identity-resolution ac-3
    const result = classifyActor("Jacob Chapel", CONFIG);
    expect(result.kind).toBe("human");
    expect(result.canonicalId).toBe("Jacob Chapel");
    expect(result.displayName).toBe("Jacob Chapel");
  });

  it("resolves case- and @-insensitive human variants", () => {
    // AC: @actor-identity-resolution ac-3
    expect(classifyActor("jacob chapel", CONFIG).kind).toBe("human");
    expect(classifyActor("@Jacob Chapel", CONFIG).kind).toBe("human");
  });

  it("uses the configured profile display name and explicit aliases", () => {
    // AC: @actor-identity-resolution ac-3
    const config: ActorIdentityConfig = {
      human: {
        canonicalId: "Jacob Chapel",
        displayName: "Jake",
        aliases: ["@jchapel", "jacob"],
      },
      agents: [],
    };
    const byAlias = classifyActor("@jchapel", config);
    expect(byAlias.kind).toBe("human");
    expect(byAlias.canonicalId).toBe("Jacob Chapel");
    expect(byAlias.displayName).toBe("Jake");
    expect(classifyActor("jacob", config).kind).toBe("human");
  });
});

describe("classifyActor — unknown (ac-4)", () => {
  it("classifies unrecognized strings as unknown and preserves the original", () => {
    // AC: @actor-identity-resolution ac-4
    for (const value of ["Test User", "Hermes", "someone@example.com"]) {
      const result = classifyActor(value, CONFIG);
      expect(result.kind).toBe("unknown");
      expect(result.canonicalId).toBeNull();
      expect(result.displayName).toBe(value);
      expect(result.original).toBe(value);
    }
  });

  it("never throws on empty or malformed input", () => {
    // AC: @actor-identity-resolution ac-4
    expect(() => classifyActor("", CONFIG)).not.toThrow();
    expect(classifyActor("", CONFIG).kind).toBe("unknown");
    expect(() => classifyActor("   ", CONFIG)).not.toThrow();
    // Defensive: non-string input must not throw.
    expect(() => classifyActor(undefined as unknown as string, CONFIG)).not.toThrow();
    expect(classifyActor(undefined as unknown as string, CONFIG).kind).toBe("unknown");
  });

  it("classifies everything as unknown when no identities are configured", () => {
    // AC: @actor-identity-resolution ac-4
    const empty: ActorIdentityConfig = { human: null, agents: [] };
    expect(classifyActor("codex", empty).kind).toBe("unknown");
    expect(classifyActor("Jacob Chapel", empty).kind).toBe("unknown");
  });
});

describe("classifyActor — determinism (ac-5)", () => {
  it("returns identical results for the same input and config", () => {
    // AC: @actor-identity-resolution ac-5
    const inputs = ["codex@openai.com", "Jacob Chapel", "Test User", "@dispatch"];
    for (const input of inputs) {
      const first = classifyActor(input, CONFIG);
      const second = classifyActor(input, CONFIG);
      expect(second).toEqual(first);
    }
  });

  it("a compiled classifier yields the same result as the one-shot function", () => {
    // AC: @actor-identity-resolution ac-5
    const classify = buildActorClassifier(CONFIG);
    for (const input of ["codex-reviewer", "@kspec", "jacob chapel", "nobody"]) {
      expect(classify(input)).toEqual(classifyActor(input, CONFIG));
    }
  });
});
