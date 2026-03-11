import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { initContext } from "../src/parser/index.js";
import { scanACAnnotations, validate } from "../src/parser/validate.js";

const repoRoot = path.resolve(__dirname, "..");
const OWN_WARNING_THRESHOLD = 98;
const sweepRefs = [
  "@task-add",
  "@plan-support",
  "@plan-import",
  "@task-automation-eligibility",
  "@ulid-system",
  "@slug-system",
  "@slug-uniqueness",
  "@slug-resolution",
  "@reference-system",
  "@trait-priority-parameter",
] as const;

// AC: @test-annotation-sweep
describe("test annotation sweep", () => {
  it("keeps trait coverage warnings at zero and reduces own coverage warning debt below the sweep threshold", async () => {
    const ctx = await initContext(repoRoot);
    const result = await validate(ctx, {
      schema: false,
      refs: false,
      orphans: false,
      completeness: true,
    });

    const traitWarnings = result.completenessWarnings.filter(
      (warning) =>
        warning.type === "missing_test_coverage" &&
        warning.subtype === "trait_ac",
    );
    expect(traitWarnings).toHaveLength(0);

    const ownWarnings = result.completenessWarnings.filter(
      (warning) =>
        warning.type === "missing_test_coverage" &&
        warning.subtype === "own_ac",
    );
    expect(ownWarnings.length).toBeLessThanOrEqual(OWN_WARNING_THRESHOLD);
  });

  it("keeps the sweep target refs machine-parseable by the AC scanner", async () => {
    const annotations = await scanACAnnotations(repoRoot);
    const refs = new Set(annotations.map((annotation) => annotation.specRef));

    for (const ref of sweepRefs) {
      expect(refs.has(ref)).toBe(true);
    }
  });
});
