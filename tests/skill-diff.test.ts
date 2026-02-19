/**
 * Tests for generateUnifiedDiff
 *
 * AC: @guard-script-and-diff-quality ac-2 - diff shows only insertion, not cascade
 */
import { describe, it, expect } from "vitest";
import { generateUnifiedDiff } from "../src/cli/commands/skill-diff.js";

describe("generateUnifiedDiff", () => {
  // AC: @guard-script-and-diff-quality ac-2
  it("should show only the insertion when a single line is inserted", () => {
    const original = ["line 1", "line 2", "line 3", "line 4", "line 5"].join(
      "\n"
    );
    const modified = [
      "line 1",
      "line 2",
      "inserted line",
      "line 3",
      "line 4",
      "line 5",
    ].join("\n");

    const diff = generateUnifiedDiff(original, modified, "a/file", "b/file");

    // Should have a diff
    expect(diff.length).toBeGreaterThan(0);

    // Count added/removed lines (excluding --- and +++ headers)
    const added = diff.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++")
    );
    const removed = diff.filter(
      (l) => l.startsWith("-") && !l.startsWith("---")
    );

    // A single insertion should show 1 added line and 0 removed lines
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);
    expect(added[0]).toBe("+inserted line");
  });

  it("should return empty array for identical content", () => {
    const content = "line 1\nline 2\nline 3";
    const diff = generateUnifiedDiff(content, content, "a/file", "b/file");
    expect(diff).toEqual([]);
  });

  it("should handle line modifications correctly", () => {
    const original = "line 1\nline 2\nline 3";
    const modified = "line 1\nmodified line 2\nline 3";

    const diff = generateUnifiedDiff(original, modified, "a/file", "b/file");

    const added = diff.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++")
    );
    const removed = diff.filter(
      (l) => l.startsWith("-") && !l.startsWith("---")
    );

    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]).toBe("-line 2");
    expect(added[0]).toBe("+modified line 2");
  });
});
