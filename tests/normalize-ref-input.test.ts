import { describe, it, expect } from "vitest";
import { normalizeRefInput } from "../src/schema/common";

describe("normalizeRefInput", () => {
  it("should add @ prefix to bare slugs", () => {
    expect(normalizeRefInput("my-task")).toBe("@my-task");
  });

  it("should preserve existing @ prefix", () => {
    expect(normalizeRefInput("@my-task")).toBe("@my-task");
  });

  it("should add @ prefix to bare ULIDs", () => {
    expect(normalizeRefInput("01JHNKAB")).toBe("@01JHNKAB");
  });

  it("should preserve @ prefix on ULIDs", () => {
    expect(normalizeRefInput("@01JHNKAB")).toBe("@01JHNKAB");
  });

  it("should handle full-length ULIDs", () => {
    const ulid = "01KJ4SM5NXME299C3KB4FG7J0A";
    expect(normalizeRefInput(ulid)).toBe(`@${ulid}`);
    expect(normalizeRefInput(`@${ulid}`)).toBe(`@${ulid}`);
  });

  it("should handle empty-ish strings gracefully", () => {
    // Edge case: single character
    expect(normalizeRefInput("a")).toBe("@a");
    // Already prefixed single char
    expect(normalizeRefInput("@a")).toBe("@a");
  });
});
