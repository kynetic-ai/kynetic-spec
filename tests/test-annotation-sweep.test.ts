import { access } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { initContext } from "../src/parser/index.js";
import { scanACAnnotations, validate } from "../src/parser/validate.js";

const repoRoot = path.resolve(__dirname, "..");
const forbiddenBareRefs = new Set([
  "@task-add",
  "@plan-support",
  "@plan-import",
  "@trait-priority-parameter",
  "@test-annotation-sweep",
]);

describe("test annotation sweep", () => {
  // AC: @test-annotation-sweep ac-trait-coverage
  it("keeps trait coverage warnings at zero after removing blanket refs", async () => {
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
  });

  // AC: @test-annotation-sweep ac-annotation-format
  it("rejects blanket sweep refs and removes the filename registry shortcut", async () => {
    const annotations = await scanACAnnotations(repoRoot);
    const bareRefs = annotations
      .map((annotation) => ({
        ...annotation,
        relFile: path.relative(repoRoot, annotation.file).replaceAll(path.sep, "/"),
      }))
      .filter(
        (annotation) =>
          forbiddenBareRefs.has(annotation.specRef) && annotation.acIds.length === 0,
      )
      .map((annotation) => `${annotation.specRef} at ${annotation.relFile}:${annotation.line}`);

    expect(bareRefs).toEqual([]);
    await expect(access(path.join(repoRoot, "tests", "annotation-sweep-registry.test.ts"))).rejects.toThrow();
  });
});
