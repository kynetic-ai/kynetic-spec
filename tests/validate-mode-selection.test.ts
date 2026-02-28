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

describe("validate mode selection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("kspec-validate-mode-");
    initGitRepo(tmpDir);
    await setupProjectWithTargetedWarnings(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  });

  async function setupProjectWithTargetedWarnings(rootDir: string): Promise<void> {
    const specDir = path.join(rootDir, "spec");
    await fs.mkdir(specDir, { recursive: true });

    const specUlid = testUlid("SPEC01");
    const taskUlid = testUlid("TASK01");

    await fs.writeFile(
      path.join(rootDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: validate-mode-test
  version: 0.1.0
includes:
  - "spec/module.yaml"
tasks:
  - "spec/project.tasks.yaml"
`,
    );

    // Missing acceptance_criteria triggers completeness warnings.
    // completed task against not_started spec triggers staleness + alignment mismatch.
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: ${specUlid}
  slugs:
    - mode-spec
  title: Mode Spec
  type: feature
  description: Spec used to verify validate mode isolation
  status:
    implementation: not_started
`,
    );

    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      `tasks:
  - _ulid: ${taskUlid}
    slugs:
      - task-mode-spec
    title: Completed task for mode spec
    status: completed
    spec_ref: "@mode-spec"
`,
    );
  }

  it("runs only schema checks for --schema", () => {
    const result = kspecWithStatus("validate --schema", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("Completeness warnings");
    expect(output).not.toContain("Alignment warnings");
    expect(output).not.toContain("Staleness warnings");
  });

  it("runs only reference checks for --refs", () => {
    const result = kspecWithStatus("validate --refs", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("Completeness warnings");
    expect(output).not.toContain("Alignment warnings");
    expect(output).not.toContain("Staleness warnings");
  });

  it("runs only alignment checks for --alignment", () => {
    const result = kspecWithStatus("validate --alignment", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(6);
    expect(output).toContain("Alignment warnings");
    expect(output).not.toContain("Completeness warnings");
    expect(output).not.toContain("Staleness warnings");
  });

  it("runs only completeness checks for --completeness", () => {
    const result = kspecWithStatus("validate --completeness", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(6);
    expect(output).toContain("Completeness warnings");
    expect(output).not.toContain("Alignment warnings");
    expect(output).not.toContain("Staleness warnings");
  });

  it("runs only staleness checks for --staleness", () => {
    const result = kspecWithStatus("validate --staleness", tmpDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(6);
    expect(output).toContain("Staleness warnings");
    expect(output).not.toContain("Alignment warnings");
    expect(output).not.toContain("Completeness warnings");
  });

  it("runs combined scopes when flags are combined", () => {
    const result = kspecWithStatus(
      "validate --alignment --completeness",
      tmpDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(6);
    expect(output).toContain("Alignment warnings");
    expect(output).toContain("Completeness warnings");
    expect(output).not.toContain("Staleness warnings");
  });
});
