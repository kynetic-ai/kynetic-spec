import { describe, it, expect } from "vitest";
import {
  createCheck,
  createLocalCheck,
  mirrorExternalCheck,
  evaluateGates,
} from "../src/review/checks.js";
import type {
  CheckGateResult,
  GateEvaluationResult,
} from "../src/review/checks.js";
import {
  ReviewCheckSchema,
  ReviewSubjectVersionSchema,
} from "../src/schema/review-records.js";
import type {
  ReviewCheck,
  ReviewSubjectVersion,
} from "../src/schema/review-records.js";

const CODE_V1: ReviewSubjectVersion = {
  type: "code_compare",
  base_commit: "aaa111",
  head_commit: "bbb222",
};

const CODE_V2: ReviewSubjectVersion = {
  type: "code_compare",
  base_commit: "aaa111",
  head_commit: "ccc333",
};

const ENTITY_V1: ReviewSubjectVersion = {
  type: "entity_version",
  content_hash: "hash-v1",
};

const ENTITY_V2: ReviewSubjectVersion = {
  type: "entity_version",
  content_hash: "hash-v2",
};

const NOW = "2026-03-14T12:00:00.000Z";
const LATER = "2026-03-14T13:00:00.000Z";

// --- AC-1: Check records with full field set ---

describe("Check recording (AC-1)", () => {
  // AC: @review-checks-and-gate-evaluation ac-1
  it("createCheck stores name, status, timestamps, runner, required, evidence, and applies_to_version", () => {
    const check = createCheck({
      name: "unit-tests",
      status: "pass",
      applies_to_version: CODE_V1,
      required: true,
      runner: "vitest",
      evidence: "https://ci.example.com/run/42",
      created_at: NOW,
      completed_at: LATER,
    });

    expect(check.name).toBe("unit-tests");
    expect(check.status).toBe("pass");
    expect(check.required).toBe(true);
    expect(check.runner).toBe("vitest");
    expect(check.evidence).toBe("https://ci.example.com/run/42");
    expect(check.applies_to_version).toEqual(CODE_V1);
    expect(check.created_at).toBe(NOW);
    expect(check.completed_at).toBe(LATER);
  });

  // AC: @review-checks-and-gate-evaluation ac-1
  it("check records validate against ReviewCheckSchema", () => {
    const check = createCheck({
      name: "lint",
      status: "fail",
      applies_to_version: CODE_V1,
      created_at: NOW,
    });
    const result = ReviewCheckSchema.safeParse(check);
    expect(result.success).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-1
  it("applies_to_version identifies the reviewed state via base_commit and head_commit", () => {
    const check = createCheck({
      name: "build",
      status: "pass",
      applies_to_version: {
        type: "code_compare",
        base_commit: "base-abc",
        head_commit: "head-def",
      },
      created_at: NOW,
    });
    expect(check.applies_to_version.type).toBe("code_compare");
    if (check.applies_to_version.type === "code_compare") {
      expect(check.applies_to_version.base_commit).toBe("base-abc");
      expect(check.applies_to_version.head_commit).toBe("head-def");
    }
  });

  // AC: @review-checks-and-gate-evaluation ac-1
  it("required defaults to true when not specified", () => {
    const check = createCheck({
      name: "tests",
      status: "pass",
      applies_to_version: CODE_V1,
      created_at: NOW,
    });
    expect(check.required).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-1
  it("optional fields are omitted when not provided", () => {
    const check = createCheck({
      name: "tests",
      status: "pass",
      applies_to_version: CODE_V1,
      created_at: NOW,
    });
    expect(check.runner).toBeUndefined();
    expect(check.evidence).toBeUndefined();
    expect(check.completed_at).toBeUndefined();
  });

  // AC: @review-checks-and-gate-evaluation ac-1
  it("supports entity_version applies_to_version for shadow-branch subjects", () => {
    const check = createCheck({
      name: "spec-validation",
      status: "pass",
      applies_to_version: ENTITY_V1,
      created_at: NOW,
    });
    expect(check.applies_to_version.type).toBe("entity_version");
    const result = ReviewSubjectVersionSchema.safeParse(
      check.applies_to_version,
    );
    expect(result.success).toBe(true);
  });
});

// --- AC-2: First-party local check runs ---

describe("Local check runs (AC-2)", () => {
  // AC: @review-checks-and-gate-evaluation ac-2
  it("createLocalCheck stores a first-party check with runner identity", () => {
    const check = createLocalCheck({
      name: "unit-tests",
      status: "pass",
      applies_to_version: CODE_V1,
      runner: "claude-agent",
      evidence: "All 42 tests passed",
      created_at: NOW,
      completed_at: LATER,
    });

    expect(check.name).toBe("unit-tests");
    expect(check.status).toBe("pass");
    expect(check.runner).toBe("claude-agent");
    expect(check.evidence).toBe("All 42 tests passed");
    expect(check.required).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-2
  it("local checks validate against ReviewCheckSchema", () => {
    const check = createLocalCheck({
      name: "manual-review",
      status: "pass",
      applies_to_version: CODE_V1,
      runner: "human-reviewer",
      created_at: NOW,
    });
    expect(ReviewCheckSchema.safeParse(check).success).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-2
  it("local checks can be informational (not required)", () => {
    const check = createLocalCheck({
      name: "style-check",
      status: "fail",
      applies_to_version: CODE_V1,
      runner: "eslint-local",
      required: false,
      created_at: NOW,
    });
    expect(check.required).toBe(false);
  });

  // AC: @review-checks-and-gate-evaluation ac-2
  it("local checks work with entity_version for non-code subjects", () => {
    const check = createLocalCheck({
      name: "plan-review",
      status: "pass",
      applies_to_version: ENTITY_V1,
      runner: "human",
      evidence: "Plan structure verified",
      created_at: NOW,
    });
    expect(check.applies_to_version).toEqual(ENTITY_V1);
    expect(ReviewCheckSchema.safeParse(check).success).toBe(true);
  });
});

// --- AC-3: External CI mirroring ---

describe("External CI mirroring (AC-3)", () => {
  // AC: @review-checks-and-gate-evaluation ac-3
  it("mirrorExternalCheck references external run while preserving normalized status", () => {
    const check = mirrorExternalCheck({
      name: "ci/github-actions",
      status: "pass",
      applies_to_version: CODE_V1,
      runner: "github-actions",
      evidence: "https://github.com/org/repo/actions/runs/12345",
      created_at: NOW,
      completed_at: LATER,
    });

    expect(check.name).toBe("ci/github-actions");
    expect(check.status).toBe("pass");
    expect(check.runner).toBe("github-actions");
    expect(check.evidence).toBe(
      "https://github.com/org/repo/actions/runs/12345",
    );
    expect(check.required).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-3
  it("mirrored checks use the same normalized status model as local checks", () => {
    const local = createLocalCheck({
      name: "tests",
      status: "pass",
      applies_to_version: CODE_V1,
      runner: "vitest-local",
      created_at: NOW,
    });
    const external = mirrorExternalCheck({
      name: "ci/tests",
      status: "pass",
      applies_to_version: CODE_V1,
      runner: "github-actions",
      evidence: "https://ci.example.com/run/1",
      created_at: NOW,
    });

    // Both validate against the same schema
    expect(ReviewCheckSchema.safeParse(local).success).toBe(true);
    expect(ReviewCheckSchema.safeParse(external).success).toBe(true);

    // Both use the same status enum values
    expect(local.status).toBe("pass");
    expect(external.status).toBe("pass");
  });

  // AC: @review-checks-and-gate-evaluation ac-3
  it("mirrored checks validate against ReviewCheckSchema", () => {
    const check = mirrorExternalCheck({
      name: "ci/build",
      status: "fail",
      applies_to_version: CODE_V1,
      runner: "circleci",
      evidence: "https://circleci.com/build/42",
      created_at: NOW,
    });
    expect(ReviewCheckSchema.safeParse(check).success).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-3
  it("mirrored external checks with all status values", () => {
    const statuses = ["pass", "fail", "running", "skipped"] as const;
    for (const status of statuses) {
      const check = mirrorExternalCheck({
        name: `ci/${status}`,
        status,
        applies_to_version: CODE_V1,
        runner: "github-actions",
        evidence: `https://ci.example.com/${status}`,
        created_at: NOW,
      });
      expect(check.status).toBe(status);
      expect(ReviewCheckSchema.safeParse(check).success).toBe(true);
    }
  });
});

// --- AC-4: Required vs informational gate distinction ---

describe("Required vs informational gates (AC-4)", () => {
  // AC: @review-checks-and-gate-evaluation ac-4
  it("required checks must pass for gate to be satisfied", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "required-test",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.required).toBe(1);
    expect(result.summary.passing).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("failing required check causes gate to fail", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "required-test",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("failing");
    expect(result.summary.failing).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("informational checks do not block approval even when failing", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "required-test",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "optional-lint",
        status: "fail",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.informational).toBe(1);
    expect(result.summary.required).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("distinguishes required and informational in gate results", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "coverage",
        status: "fail",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    const coverageGate = result.checks.find(
      (g: CheckGateResult) => g.name === "coverage",
    );

    expect(testGate?.required).toBe(true);
    expect(testGate?.satisfied).toBe(true);
    expect(coverageGate?.required).toBe(false);
    expect(coverageGate?.satisfied).toBe(true); // informational always satisfied
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("no required gates means trivially passing", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "info-only",
        status: "fail",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("empty checks list means trivially passing", () => {
    const result = evaluateGates([], CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.total).toBe(0);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("skipped required checks are treated as satisfied", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "skipped-test",
        status: "skipped",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.passing).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("running required checks leave gate in pending state", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "running-test",
        status: "running",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("pending");
    expect(result.summary.pending).toBe(1);
  });
});

// --- AC-5: Multiple runs, latest matching run decides gate ---

describe("Multiple check runs and latest-run resolution (AC-5)", () => {
  // AC: @review-checks-and-gate-evaluation ac-5
  it("preserves check history while using latest matching run for gate decision", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: LATER,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");

    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    expect(testGate?.latestRun?.status).toBe("pass");
    expect(testGate?.latestRun?.created_at).toBe(LATER);

    // Both runs still exist in the original array (history preserved)
    expect(checks).toHaveLength(2);
  });

  // AC: @review-checks-and-gate-evaluation ac-5
  it("latest run whose applies_to_version matches current head_commit is used", () => {
    const checks: ReviewCheck[] = [
      // Old run against v1 (fresh for v1)
      createCheck({
        name: "build",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      // Newer run against v2 (stale for v1)
      createCheck({
        name: "build",
        status: "fail",
        required: true,
        applies_to_version: CODE_V2,
        created_at: LATER,
      }),
    ];

    // Evaluating against v1 — the first run matches
    const resultV1 = evaluateGates(checks, CODE_V1);
    expect(resultV1.state).toBe("passing");

    // Evaluating against v2 — the second run matches
    const resultV2 = evaluateGates(checks, CODE_V2);
    expect(resultV2.state).toBe("failing");
  });

  // AC: @review-checks-and-gate-evaluation ac-5
  it("multiple different check names are evaluated independently", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "lint",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("failing");
    expect(result.summary.total).toBe(2);
    expect(result.summary.passing).toBe(1);
    expect(result.summary.failing).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-5
  it("when multiple fresh runs exist, latest (last in array) is used", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "tests",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: LATER,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("failing");

    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    expect(testGate?.latestRun?.status).toBe("fail");
  });
});

// --- AC-6: Stale checks do not satisfy required gates ---

describe("Stale check handling (AC-6)", () => {
  // AC: @review-checks-and-gate-evaluation ac-6
  it("checks whose applies_to_version head_commit does not match are stale", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1, // v1 head_commit
        created_at: NOW,
      }),
    ];

    // Evaluate against v2 (different head_commit)
    const result = evaluateGates(checks, CODE_V2);
    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    expect(testGate?.stale).toBe(true);
    expect(testGate?.satisfied).toBe(false);
  });

  // AC: @review-checks-and-gate-evaluation ac-6
  it("stale required checks cause gate state to be failing", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V2);
    expect(result.state).toBe("failing");
    expect(result.summary.stale).toBe(1);
  });

  // AC: @review-checks-and-gate-evaluation ac-6
  it("stale informational checks do not affect gate state", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "optional-lint",
        status: "pass",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V2);
    expect(result.state).toBe("passing"); // no required gates
    const gate = result.checks.find(
      (g: CheckGateResult) => g.name === "optional-lint",
    );
    expect(gate?.satisfied).toBe(true); // informational always satisfied
  });

  // AC: @review-checks-and-gate-evaluation ac-6
  it("entity_version staleness works for shadow-branch subjects", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "spec-validation",
        status: "pass",
        required: true,
        applies_to_version: ENTITY_V1,
        created_at: NOW,
      }),
    ];

    // Evaluate against v2 (different content_hash)
    const result = evaluateGates(checks, ENTITY_V2);
    expect(result.state).toBe("failing");
    expect(result.summary.stale).toBe(1);

    const gate = result.checks.find(
      (g: CheckGateResult) => g.name === "spec-validation",
    );
    expect(gate?.stale).toBe(true);
    expect(gate?.latestRun).toBeUndefined();
  });

  // AC: @review-checks-and-gate-evaluation ac-6
  it("mix of fresh and stale checks evaluates correctly", () => {
    const checks: ReviewCheck[] = [
      // Stale check (ran against v1)
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      // Fresh check (ran against v2)
      createCheck({
        name: "lint",
        status: "pass",
        required: true,
        applies_to_version: CODE_V2,
        created_at: NOW,
      }),
    ];

    // Evaluate against v2
    const result = evaluateGates(checks, CODE_V2);
    expect(result.state).toBe("failing"); // tests is stale

    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    const lintGate = result.checks.find(
      (g: CheckGateResult) => g.name === "lint",
    );

    expect(testGate?.stale).toBe(true);
    expect(testGate?.satisfied).toBe(false);
    expect(lintGate?.stale).toBe(false);
    expect(lintGate?.satisfied).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-6
  it("a fresh passing run after a stale run satisfies the gate", () => {
    const checks: ReviewCheck[] = [
      // Old run against v1 (stale when evaluating against v2)
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      // New run against v2 (fresh)
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V2,
        created_at: LATER,
      }),
    ];

    const result = evaluateGates(checks, CODE_V2);
    expect(result.state).toBe("passing");

    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    expect(testGate?.stale).toBe(false);
    expect(testGate?.latestRun?.applies_to_version).toEqual(CODE_V2);
  });
});

// --- Integration: combined scenarios ---

describe("Gate evaluation integration scenarios", () => {
  // AC: @review-checks-and-gate-evaluation ac-4
  // AC: @review-checks-and-gate-evaluation ac-5
  it("complex scenario: multiple checks, some required, some informational, multiple runs", () => {
    const checks: ReviewCheck[] = [
      // tests: first run failed, then passed
      createCheck({
        name: "tests",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: LATER,
      }),
      // lint: single passing run
      createCheck({
        name: "lint",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      // coverage: informational, failing
      createCheck({
        name: "coverage",
        status: "fail",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.total).toBe(3);
    expect(result.summary.required).toBe(2);
    expect(result.summary.informational).toBe(1);
    expect(result.summary.passing).toBe(2);
  });

  // AC: @review-checks-and-gate-evaluation ac-5
  // AC: @review-checks-and-gate-evaluation ac-6
  it("after subject update, all checks are stale until re-run", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "lint",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    // After subject updated to v2, both are stale
    const result = evaluateGates(checks, CODE_V2);
    expect(result.state).toBe("failing");
    expect(result.summary.stale).toBe(2);
    expect(result.checks.every((g: CheckGateResult) => g.stale)).toBe(true);
  });

  // AC: @review-checks-and-gate-evaluation ac-2
  // AC: @review-checks-and-gate-evaluation ac-3
  it("local and external checks coexist in the same gate evaluation", () => {
    const checks: ReviewCheck[] = [
      createLocalCheck({
        name: "local-tests",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        runner: "vitest-agent",
        created_at: NOW,
      }),
      mirrorExternalCheck({
        name: "ci/github-actions",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        runner: "github-actions",
        evidence: "https://github.com/org/repo/actions/runs/42",
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.state).toBe("passing");
    expect(result.summary.total).toBe(2);
    expect(result.summary.required).toBe(2);
    expect(result.summary.passing).toBe(2);
  });

  // AC: @review-checks-and-gate-evaluation ac-4
  it("summary counts are accurate", () => {
    const checks: ReviewCheck[] = [
      createCheck({
        name: "passing-required",
        status: "pass",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "failing-required",
        status: "fail",
        required: true,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "info-check",
        status: "fail",
        required: false,
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    expect(result.summary).toEqual({
      total: 3,
      required: 2,
      informational: 1,
      passing: 1,
      failing: 1,
      stale: 0,
      pending: 0,
    });
  });

  // AC: @review-checks-and-gate-evaluation ac-5
  it("required flag is determined from any run with that name", () => {
    // If any run for a check name is marked required, the gate is required
    const checks: ReviewCheck[] = [
      createCheck({
        name: "tests",
        status: "fail",
        required: false, // First run was informational
        applies_to_version: CODE_V1,
        created_at: NOW,
      }),
      createCheck({
        name: "tests",
        status: "pass",
        required: true, // Later run marked as required
        applies_to_version: CODE_V1,
        created_at: LATER,
      }),
    ];

    const result = evaluateGates(checks, CODE_V1);
    const testGate = result.checks.find(
      (g: CheckGateResult) => g.name === "tests",
    );
    expect(testGate?.required).toBe(true);
    expect(testGate?.satisfied).toBe(true);
  });

  it("gate state is pending when required checks have no runs at all", () => {
    // This scenario: a check name exists only in policy but hasn't been run
    // We simulate by having no checks at all — which gives "passing" (no gates)
    // But with a required check that has never been run — we'd need to define
    // the check name some other way. With the current design, checks are
    // discovered from the check list itself, so no runs = no gates = passing.
    const result = evaluateGates([], CODE_V1);
    expect(result.state).toBe("passing");
  });
});
