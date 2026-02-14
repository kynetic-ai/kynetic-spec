import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspecOutput as kspec,
  kspecWithStatus,
} from "./helpers/cli";

/**
 * Tests for AC schema field drift detection
 * Task: @01KGGZKQ
 *
 * Validates that acceptance criteria don't reference schema fields that don't exist.
 */
describe("AC Schema Drift detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("kspec-drift-test-");
    initGitRepo(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  });

  it("should warn when AC references non-existent field like item.children", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references children field (doesn't exist in schema)
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a parent item with children
      when: the item.children are modified
      then: all item.children should be updated
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift warnings");
    expect(result).toContain("item.children");
    expect(result).toContain("parse-time/conceptual field");
  });

  it("should warn when AC references spec_ref.field (spec_ref is a string, not object)", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references spec_ref.children
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with ref drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a task with a spec_ref
      when: the spec_ref.status changes
      then: the task should reflect spec_ref.children state
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift warnings");
    expect(result).toContain("spec_ref");
    expect(result).toContain("reference string, not an object");
  });

  it("should NOT warn when AC references valid schema fields", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references valid fields
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with valid refs
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a spec item
      when: the item.status is updated
      then: the item.tags should reflect the change
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift: OK");
    expect(result).not.toContain("AC Schema Drift warnings");
  });

  it("should warn when AC references task fields that don't exist", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references unknown task field
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with task drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a task
      when: the task.foobar changes
      then: task.baz should be updated
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift warnings");
    expect(result).toContain("task.foobar");
    expect(result).toContain("not a known schema field");
  });

  it("should accept valid status.maturity and status.implementation references", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references status fields
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with status refs
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a spec item
      when: status.maturity is updated
      then: status.implementation should be validated
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift: OK");
  });

  it("should only run drift checks when --drift flag is provided", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC that references children field
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a parent item
      when: item.children are modified
      then: item.children should be updated
`,
    );

    // Run validate WITHOUT --drift flag
    const resultWithoutFlag = kspec("validate", tmpDir);

    // Should NOT contain drift warnings
    expect(resultWithoutFlag).not.toContain("AC Schema Drift");

    // Run validate WITH --drift flag
    const resultWithFlag = kspec("validate --drift", tmpDir);

    // Should contain drift warnings
    expect(resultWithFlag).toContain("AC Schema Drift");
  });

  it("should exit with code 6 for warnings, code 4 with --strict", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with AC drift issue
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a parent item
      when: item.children are modified
      then: item.children should be updated
`,
    );

    // Run validate --drift (without --strict) - should exit 6 (warnings present)
    const resultNoStrict = kspecWithStatus("validate --drift", tmpDir);
    expect(resultNoStrict.exitCode).toBe(6); // VALIDATION_WARNINGS

    // Run validate --drift --strict - should exit 4 (warnings treated as errors)
    const resultStrict = kspecWithStatus("validate --drift --strict", tmpDir);
    expect(resultStrict.exitCode).toBe(4); // VALIDATION_FAILED
  });

  it("should report multiple drift issues in the same AC", async () => {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir);

    // Create manifest
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.0"
project:
  name: test-project
  version: 0.1.0
includes:
  - "spec/module.yaml"
`,
    );

    // Create spec with multiple drift issues
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - test-spec
  title: Test Spec with multiple drift
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: an item with item.children and spec_ref.status
      when: item.parent changes
      then: spec_ref.children should cascade to item.children
`,
    );

    // Run validate --drift
    const result = kspec("validate --drift", tmpDir);

    expect(result).toContain("AC Schema Drift warnings");
    // Should catch multiple issues
    expect(result).toContain("children");
    expect(result).toContain("parent");
    expect(result).toContain("spec_ref");
  });
});
