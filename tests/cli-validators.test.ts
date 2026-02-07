/**
 * Unit tests for shared CLI validation helpers.
 *
 * Task: @01KGWDPV
 */

import { describe, expect, it } from "vitest";
import {
  parseIntOption,
  validateEnumOption,
  validateSpecRef,
} from "../src/cli/validators.js";
import type { ReferenceIndex } from "../src/parser/refs.js";

// ─── parseIntOption ─────────────────────────────────────────

describe("parseIntOption", () => {
  const priorityConfig = { min: 1, max: 5, name: "Priority" };

  it("accepts valid integers within range", () => {
    expect(parseIntOption("3", priorityConfig)).toEqual({
      ok: true,
      value: 3,
    });
  });

  it("accepts boundary value (min)", () => {
    expect(parseIntOption("1", priorityConfig)).toEqual({
      ok: true,
      value: 1,
    });
  });

  it("accepts boundary value (max)", () => {
    expect(parseIntOption("5", priorityConfig)).toEqual({
      ok: true,
      value: 5,
    });
  });

  it("rejects value below min", () => {
    const result = parseIntOption("0", priorityConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("between 1 and 5");
    }
  });

  it("rejects value above max", () => {
    const result = parseIntOption("6", priorityConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("between 1 and 5");
    }
  });

  it("rejects NaN input", () => {
    const result = parseIntOption("abc", priorityConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must be a number");
    }
  });

  it("rejects partial parses like '3abc' (unlike parseInt)", () => {
    const result = parseIntOption("3abc", priorityConfig);
    expect(result.ok).toBe(false);
  });

  it("rejects floating point like '1.9'", () => {
    const result = parseIntOption("1.9", priorityConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("whole number");
    }
  });

  it("rejects empty string", () => {
    const result = parseIntOption("", priorityConfig);
    expect(result.ok).toBe(false);
  });

  it("rejects negative values when min is positive", () => {
    const result = parseIntOption("-1", priorityConfig);
    expect(result.ok).toBe(false);
  });

  it("uses custom name in error messages", () => {
    const result = parseIntOption("abc", { min: 0, max: 10, name: "Limit" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Limit");
    }
  });
});

// ─── validateEnumOption ─────────────────────────────────────

describe("validateEnumOption", () => {
  const automationStatuses = [
    "eligible",
    "needs_review",
    "manual_only",
  ] as const;

  it("accepts valid enum value", () => {
    expect(
      validateEnumOption("eligible", automationStatuses, "automation status"),
    ).toEqual({
      ok: true,
      value: "eligible",
    });
  });

  it("accepts all valid values", () => {
    for (const status of automationStatuses) {
      const result = validateEnumOption(
        status,
        automationStatuses,
        "automation status",
      );
      expect(result.ok).toBe(true);
    }
  });

  it("rejects invalid enum value", () => {
    const result = validateEnumOption(
      "foo",
      automationStatuses,
      "automation status",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid automation status: foo");
      expect(result.error).toContain("eligible");
      expect(result.error).toContain("needs_review");
      expect(result.error).toContain("manual_only");
    }
  });

  it("is case sensitive", () => {
    const result = validateEnumOption(
      "Eligible",
      automationStatuses,
      "automation status",
    );
    expect(result.ok).toBe(false);
  });
});

// ─── validateSpecRef ────────────────────────────────────────

describe("validateSpecRef", () => {
  // Minimal mocks matching the interfaces used by validateSpecRef
  const mockTasks = [
    { _ulid: "01TASK00000000000000000000", slugs: ["my-task"] },
  ] as any[];

  const mockItems = [
    { _ulid: "01SPEC00000000000000000000", slugs: ["my-spec"] },
  ] as any[];

  // Create a mock ReferenceIndex that resolves refs to ULIDs
  function createMockIndex(
    mapping: Record<string, { ok: true; ulid: string } | { ok: false; error: string }>,
  ): ReferenceIndex {
    return {
      resolve(ref: string) {
        const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
        return mapping[cleanRef] || { ok: false, error: "not_found", ref };
      },
    } as any;
  }

  it("accepts valid spec ref", () => {
    const index = createMockIndex({
      "my-spec": { ok: true, ulid: "01SPEC00000000000000000000" },
    });
    const result = validateSpecRef("@my-spec", index, mockTasks, mockItems);
    expect(result).toEqual({ ok: true, value: "@my-spec" });
  });

  it("rejects ref that resolves to a task", () => {
    const index = createMockIndex({
      "my-task": { ok: true, ulid: "01TASK00000000000000000000" },
    });
    const result = validateSpecRef("@my-task", index, mockTasks, mockItems);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("task");
    }
  });

  it("rejects ref that resolves to a meta item (not in items array)", () => {
    const index = createMockIndex({
      "my-agent": { ok: true, ulid: "01META00000000000000000000" },
    });
    const result = validateSpecRef("@my-agent", index, mockTasks, mockItems);
    expect(result.ok).toBe(false);
  });

  it("rejects ref that doesn't exist", () => {
    const index = createMockIndex({});
    const result = validateSpecRef("@nonexistent", index, mockTasks, mockItems);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });
});
