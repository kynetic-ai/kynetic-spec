/**
 * Schema-level tests for AgentSchema runner field.
 *
 * Covers:
 * - AC: @agent-definition-schema ac-runner-field-accepted
 * - AC: @agent-definition-schema ac-8 (defaults include runner: undefined)
 * - AC: @agent-runner-configuration ac-agent-runner-reference
 * - AC: @agent-runner-configuration ac-adapter-field-backcompat
 */

import { describe, it, expect } from "vitest";
import { AgentSchema } from "../src/schema/meta.js";
import { testUlid } from "./helpers/cli.js";

describe("AgentSchema runner field", () => {
  // AC: @agent-definition-schema ac-runner-field-accepted
  // AC: @agent-runner-configuration ac-agent-runner-reference
  it("accepts an optional runner field as a string", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "runner-backed",
      name: "Runner Backed",
      runner: "claude-code-default",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runner).toBe("claude-code-default");
    }
  });

  // AC: @agent-definition-schema ac-runner-field-accepted
  // Runner name resolution happens later — any string is accepted at parse time.
  it("does not validate runner name existence at schema time", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "ghost-runner",
      name: "Ghost Runner",
      runner: "does-not-exist-anywhere",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runner).toBe("does-not-exist-anywhere");
    }
  });

  // AC: @agent-definition-schema ac-8
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("parses a legacy agent (no runner, adapter only) and leaves runner undefined", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "legacy",
      name: "Legacy Agent",
      adapter: "claude-agent-acp",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runner).toBeUndefined();
      expect(result.data.adapter).toBe("claude-agent-acp");
    }
  });

  // AC: @agent-definition-schema ac-8 — defaults include runner: undefined
  it("parses an agent with no execution fields and runner defaults to undefined", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "bare",
      name: "Bare Agent",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runner).toBeUndefined();
      expect(result.data.adapter).toBeUndefined();
    }
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // Both fields coexist at the schema layer; precedence is enforced at invocation time.
  it("accepts an agent that carries both runner and adapter", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "dual",
      name: "Dual Agent",
      runner: "claude-code-default",
      adapter: "claude-agent-acp",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runner).toBe("claude-code-default");
      expect(result.data.adapter).toBe("claude-agent-acp");
    }
  });

  it("rejects a non-string runner value", () => {
    const result = AgentSchema.safeParse({
      _ulid: testUlid("AGNT"),
      id: "bad",
      name: "Bad Runner",
      runner: 42,
    });

    expect(result.success).toBe(false);
  });
});
