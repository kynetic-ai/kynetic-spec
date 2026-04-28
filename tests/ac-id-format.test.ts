import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AcIdSchema, acIdPattern, AcceptanceCriterionSchema } from "../src/schema/index.js";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";

// AC: @acceptance-criterion-id-format ac-stored-id-format
describe("AcIdSchema - valid ac-prefixed kebab-case ids", () => {
  it("accepts ac-N numeric ids", () => {
    expect(AcIdSchema.safeParse("ac-1").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-42").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-999").success).toBe(true);
  });

  it("accepts ac-prefixed descriptive kebab-case ids", () => {
    expect(AcIdSchema.safeParse("ac-stored-id-format").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-validation-rule").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-my-criterion").success).toBe(true);
  });

  it("accepts ac-prefixed single-segment ids", () => {
    expect(AcIdSchema.safeParse("ac-validation").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-a").success).toBe(true);
  });

  it("accepts ac-prefixed ids with numbers in segments", () => {
    expect(AcIdSchema.safeParse("ac-v2").success).toBe(true);
    expect(AcIdSchema.safeParse("ac-rule3-check").success).toBe(true);
  });
});

// AC: @acceptance-criterion-id-format ac-invalid-stored-id-reported
describe("AcIdSchema - rejects invalid ids", () => {
  it("rejects ids without ac- prefix", () => {
    expect(AcIdSchema.safeParse("validation-rule").success).toBe(false);
    expect(AcIdSchema.safeParse("1").success).toBe(false);
    expect(AcIdSchema.safeParse("stored-id-format").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(AcIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects bare ac- with no suffix", () => {
    expect(AcIdSchema.safeParse("ac-").success).toBe(false);
  });

  it("rejects uppercase characters", () => {
    expect(AcIdSchema.safeParse("ac-MyRule").success).toBe(false);
    expect(AcIdSchema.safeParse("AC-1").success).toBe(false);
    expect(AcIdSchema.safeParse("Ac-validation").success).toBe(false);
  });

  it("rejects ids with trailing or double hyphens", () => {
    expect(AcIdSchema.safeParse("ac-rule-").success).toBe(false);
    expect(AcIdSchema.safeParse("ac--rule").success).toBe(false);
    expect(AcIdSchema.safeParse("ac-rule--check").success).toBe(false);
  });

  it("rejects ids with special characters", () => {
    expect(AcIdSchema.safeParse("ac-rule_check").success).toBe(false);
    expect(AcIdSchema.safeParse("ac-rule.check").success).toBe(false);
    expect(AcIdSchema.safeParse("ac-rule check").success).toBe(false);
  });
});

// AC: @acceptance-criterion-id-format ac-invalid-stored-id-reported
describe("AcceptanceCriterionSchema - rejects invalid AC id on parse", () => {
  it("rejects an AC object with a non-prefixed id", () => {
    const result = AcceptanceCriterionSchema.safeParse({
      id: "my-criterion",
      given: "a condition",
      when: "something happens",
      then: "an outcome occurs",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an AC object with a valid ac-prefixed id", () => {
    const result = AcceptanceCriterionSchema.safeParse({
      id: "ac-1",
      given: "a condition",
      when: "something happens",
      then: "an outcome occurs",
    });
    expect(result.success).toBe(true);
  });
});

describe("CLI: item ac add/set format validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Create a test item to attach ACs to
    kspec(
      'item add --under @test-core --title "AC Format Test" --slug ac-format-test',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @acceptance-criterion-id-format ac-create-rejects-invalid-id
  describe("item ac add --id rejects invalid format", () => {
    it("rejects a non-prefixed id", () => {
      const result = kspec(
        'item ac add @ac-format-test --id "bad-id" --given "g" --when "w" --then "t"',
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("rejects an uppercase id", () => {
      const result = kspec(
        'item ac add @ac-format-test --id "AC-1" --given "g" --when "w" --then "t"',
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("rejects a bare number id", () => {
      const result = kspec(
        'item ac add @ac-format-test --id "1" --given "g" --when "w" --then "t"',
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("does not mutate the item when id is invalid", () => {
      kspec(
        'item ac add @ac-format-test --id "bad-id" --given "g" --when "w" --then "t"',
        tempDir,
        { expectFail: true },
      );
      const item = kspecJson<{ acceptance_criteria?: unknown[] }>(
        "item get @ac-format-test",
        tempDir,
      );
      expect(item.acceptance_criteria ?? []).toHaveLength(0);
    });

    it("accepts a valid ac-prefixed id", () => {
      const result = kspec(
        'item ac add @ac-format-test --id "ac-valid" --given "g" --when "w" --then "t"',
        tempDir,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ac-valid");
    });
  });

  // AC: @acceptance-criterion-id-format ac-rename-rejects-invalid-id
  describe("item ac set --id rejects invalid format on rename", () => {
    beforeEach(() => {
      // Add a valid AC first
      kspec(
        'item ac add @ac-format-test --id "ac-original" --given "g" --when "w" --then "t"',
        tempDir,
      );
    });

    it("rejects renaming to a non-prefixed id", () => {
      const result = kspec(
        'item ac set @ac-format-test ac-original --id "renamed-bad"',
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ac-prefixed kebab-case");
    });

    it("does not mutate the item when rename id is invalid", () => {
      kspec(
        'item ac set @ac-format-test ac-original --id "renamed-bad"',
        tempDir,
        { expectFail: true },
      );
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @ac-format-test",
        tempDir,
      );
      expect(item.acceptance_criteria[0].id).toBe("ac-original");
    });

    it("accepts renaming to a valid ac-prefixed id", () => {
      const result = kspec(
        'item ac set @ac-format-test ac-original --id "ac-renamed"',
        tempDir,
      );
      expect(result.exitCode).toBe(0);
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @ac-format-test",
        tempDir,
      );
      expect(item.acceptance_criteria[0].id).toBe("ac-renamed");
    });
  });

  // AC: @acceptance-criterion-id-format ac-generated-ids-conform
  describe("auto-generated AC ids conform to required format", () => {
    it("generates ac-1 for the first AC", () => {
      kspec(
        'item ac add @ac-format-test --given "g" --when "w" --then "t"',
        tempDir,
      );
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @ac-format-test",
        tempDir,
      );
      expect(item.acceptance_criteria[0].id).toBe("ac-1");
      expect(acIdPattern.test(item.acceptance_criteria[0].id)).toBe(true);
    });

    it("generates sequential ac-N ids", () => {
      kspec(
        'item ac add @ac-format-test --given "g1" --when "w1" --then "t1"',
        tempDir,
      );
      kspec(
        'item ac add @ac-format-test --given "g2" --when "w2" --then "t2"',
        tempDir,
      );
      kspec(
        'item ac add @ac-format-test --given "g3" --when "w3" --then "t3"',
        tempDir,
      );
      const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
        "item get @ac-format-test",
        tempDir,
      );
      expect(item.acceptance_criteria).toHaveLength(3);
      for (const ac of item.acceptance_criteria) {
        expect(acIdPattern.test(ac.id)).toBe(true);
      }
      expect(item.acceptance_criteria.map((ac) => ac.id)).toEqual([
        "ac-1",
        "ac-2",
        "ac-3",
      ]);
    });
  });
});
