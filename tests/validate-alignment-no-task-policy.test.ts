import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspecWithStatus,
  testUlid,
} from "./helpers/cli";

describe("validate alignment: no-task spec warning policy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("kspec-align-no-task-");
    initGitRepo(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  });

  async function writeProject(
    specStatus: string,
    includeTasks: boolean,
    taskStatus = "pending",
  ): Promise<void> {
    const specUlid = testUlid("SPEC01");
    const taskUlid = testUlid("TASK01");

    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: no-task-policy-test
  version: 0.1.0
includes:
  - "module.yaml"
tasks:
  - "tasks.yaml"
`,
    );

    await fs.writeFile(
      path.join(tmpDir, "module.yaml"),
      `- _ulid: ${specUlid}
  slugs:
    - test-spec
  title: Test Spec
  type: feature
  description: Test spec for alignment policy
  status:
    implementation: ${specStatus}
`,
    );

    const tasksContent = includeTasks
      ? `tasks:
  - _ulid: ${taskUlid}
    slugs:
      - task-test-spec
    title: Task for test spec
    status: ${taskStatus}
    spec_ref: "@test-spec"
`
      : `tasks: []
`;
    await fs.writeFile(path.join(tmpDir, "tasks.yaml"), tasksContent);
  }

  // AC: @alignment-system ac-2
  // AC: @alignment-warnings ac-1
  it("emits orphaned_spec for no-task spec with not_started status", async () => {
    await writeProject("not_started", false);
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Orphaned specs");
    expect(output).toContain("Test Spec");
    expect(output).not.toContain("Status mismatches");
  });

  it("emits orphaned_spec for no-task spec with in_progress status", async () => {
    await writeProject("in_progress", false);
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Orphaned specs");
    expect(output).toContain("Test Spec");
    expect(output).not.toContain("Status mismatches");
  });

  // AC: @alignment-warnings ac-3
  it("emits no alignment warning for no-task spec with implemented status (baseline trust)", async () => {
    await writeProject("implemented", false);
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("Test Spec");
    // No alignment section should appear or it should show 0 warnings
    const hasAlignmentWarnings =
      output.includes("Orphaned specs") || output.includes("Status mismatches");
    expect(hasAlignmentWarnings).toBe(false);
  });

  // AC: @alignment-warnings ac-3
  it("emits no alignment warning for no-task spec with verified status (baseline trust)", async () => {
    await writeProject("verified", false);
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("Test Spec");
    const hasAlignmentWarnings =
      output.includes("Orphaned specs") || output.includes("Status mismatches");
    expect(hasAlignmentWarnings).toBe(false);
  });

  // AC: @alignment-warnings ac-2
  it("emits status_mismatch when tasks exist but progress disagrees with spec status", async () => {
    // spec says implemented, but task is still pending → expected not_started → mismatch
    await writeProject("implemented", true, "pending");
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Status mismatches");
    expect(output).toContain("Test Spec");
    expect(output).not.toContain("Orphaned specs");
  });

  // AC: @alignment-warnings ac-2
  it("treats needs_work task as active work (expects in_progress spec)", async () => {
    await writeProject("in_progress", true, "needs_work");
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("Status mismatches");
  });

  // AC: @alignment-warnings ac-2
  it("treats pending_review task as active work (expects in_progress spec)", async () => {
    await writeProject("in_progress", true, "pending_review");
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("Status mismatches");
  });
});
