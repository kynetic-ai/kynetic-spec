/**
 * CLI Plan Import Tests
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  kspec as kspecRun,
  kspecJson,
  kspecOutput,
  setupTempFixtures,
} from "./helpers/cli";

// AC: @trait-shadow-commit ac-1 — N/A: plan import delegates commit behavior to shared commitIfShadow coverage in shadow.test.ts.
// AC: @trait-shadow-commit ac-2 — N/A: commit message formatting is covered by shared commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-3 — N/A: commit ref formatting is covered by shared commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-4 — N/A: shadow-disabled behavior is covered by generic commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-5 — N/A: save/commit failure behavior is covered by generic commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-6 — N/A: push fire-and-forget behavior depends on remote shadow setup and is covered in shadow.test.ts.
// AC: @trait-shadow-commit ac-7 — N/A: git commit/push failure handling is covered in shadow.test.ts.
// AC: @trait-shadow-commit ac-8 — N/A: atomic single-commit behavior is covered by shared commitIfShadow tests in shadow.test.ts.
// AC: @trait-dry-run ac-5 — N/A: plan import does not implement a --force flag.
// AC: @trait-json-output ac-6 — N/A: plan import has no competing format flags beyond --json.
// AC: @trait-semantic-exit-codes ac-3 — N/A: plan import has no confirmation prompt path.
// AC: @trait-semantic-exit-codes ac-5 — N/A: plan import is a mutation command, not a query with empty-result semantics.
// AC: @trait-semantic-exit-codes ac-7 — N/A: plan import is no longer a batch partial-success operation.
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code meanings are documented centrally in src/cli/exit-codes.ts.

describe("Integration: plan import content-only", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writePlan(
    filename: string,
    content = `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`,
  ): Promise<string> {
    const planPath = path.join(tempDir, filename);
    await fs.writeFile(planPath, content);
    return planPath;
  }

  // AC: @plan-import-content-only ac-draft-default
  // AC: @plan-import-content-only ac-module-optional
  // AC: @plan-import-content-only ac-content-only
  // AC: @trait-semantic-exit-codes ac-1
  it("stores the full document as a draft plan without creating specs or tasks", async () => {
    const planPath = await writePlan("test-plan.md");

    const output = kspecOutput(`plan import "${planPath}"`, tempDir);
    expect(output).toContain("Plan: @plan-test-plan");
    expect(output).toContain("Status: draft");
    expect(output).toContain("Content stored: full document");
    expect(output).toContain("Derived specs: 0");
    expect(output).toContain("Derived tasks: 0");

    const plan = kspecJson<{
      status: string;
      content: string;
      derived_specs: string[];
      derived_tasks: string[];
      module_ref: string | null;
      source_path: string;
    }>("plan get @plan-test-plan", tempDir);
    expect(plan.status).toBe("draft");
    expect(plan.content).toContain("## Specs");
    expect(plan.content).toContain("derive_from_specs: true");
    expect(plan.derived_specs).toEqual([]);
    expect(plan.derived_tasks).toEqual([]);
    expect(plan.module_ref).toBeNull();
    expect(plan.source_path).toContain("test-plan.md");

    const tasks = kspecJson<Array<{ plan_ref?: string }>>("task list", tempDir);
    expect(tasks.filter((task) => task.plan_ref === "@plan-test-plan")).toEqual([]);
  });

  // AC: @plan-import-content-only ac-status-override
  it("accepts an explicit plan status during import", async () => {
    const planPath = await writePlan("approved-plan.md");

    kspecOutput(`plan import "${planPath}" --status approved`, tempDir);

    const plan = kspecJson<{ status: string }>("plan get @plan-test-plan", tempDir);
    expect(plan.status).toBe("approved");
  });

  // AC: @plan-import-content-only ac-module-stored
  it("stores the optional module reference on the imported plan", async () => {
    const planPath = await writePlan("module-plan.md");

    kspecOutput(`plan import "${planPath}" --module @test-core`, tempDir);

    const plan = kspecJson<{ module_ref: string | null }>(
      "plan get @plan-test-plan",
      tempDir,
    );
    expect(plan.module_ref).toBe("@test-core");
  });

  // AC: @plan-import-content-only ac-update-ignored
  it("warns and still imports content-only when --update is passed", async () => {
    const planPath = await writePlan("update-plan.md");

    const result = kspecRun(`plan import "${planPath}" --update`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--update is ignored for content-only import");

    const plan = kspecJson<{ derived_specs: string[]; derived_tasks: string[] }>(
      "plan get @plan-test-plan",
      tempDir,
    );
    expect(plan.derived_specs).toEqual([]);
    expect(plan.derived_tasks).toEqual([]);
  });

  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  // AC: @trait-json-output ac-4
  // AC: @trait-json-output ac-5
  it("supports dry-run previews in JSON mode without modifying state", async () => {
    const planPath = await writePlan("dry-run-plan.md");

    const preview = kspecJson<{
      dry_run: boolean;
      plan_ref: string;
      title: string;
      status: string;
      module_ref: string | null;
      source_path: string;
      created_at: string | null;
      derived_specs: string[];
      derived_tasks: string[];
      content: string;
    }>(`plan import "${planPath}" --module @test-core --dry-run`, tempDir);

    expect(preview.dry_run).toBe(true);
    expect(preview.plan_ref).toBe("@plan-test-plan");
    expect(preview.title).toBe("Test Plan");
    expect(preview.status).toBe("draft");
    expect(preview.module_ref).toBe("@test-core");
    expect(preview.source_path).toContain("dry-run-plan.md");
    expect(preview.created_at).toBeNull();
    expect(preview.derived_specs).toEqual([]);
    expect(preview.derived_tasks).toEqual([]);
    expect(preview.content).toContain("## Specs");

    const plans = kspecJson<Array<{ slugs: string[] }>>("plan list", tempDir);
    expect(plans.some((plan) => plan.slugs.includes("plan-test-plan"))).toBe(false);
  });

  // AC: @trait-dry-run ac-4
  // AC: @trait-json-output ac-3
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-semantic-exit-codes ac-6
  it("returns a JSON usage error when the source file cannot be read", () => {
    const missingPath = path.join(tempDir, "missing-plan.md");

    const result = kspecRun(`plan import "${missingPath}" --json`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      success: false,
      error: `Failed to read plan file: ${missingPath}`,
    });
  });
});
