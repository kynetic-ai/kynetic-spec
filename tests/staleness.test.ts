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
 * Tests for staleness detection
 * AC: @stale-status-detection
 */
describe("Staleness detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("kspec-staleness-test-");
    initGitRepo(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  });

  // AC: @stale-status-detection parent-pending-children-done
  it("should warn when task dependencies are completed but task is pending", async () => {
    // Create spec directory
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec module
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01TESTSPEC00000001
  slugs:
    - test-feature
  title: Test Feature
  type: feature
  status:
    implementation: implemented
`,
    );

    // Create task file with parent task that has completed dependencies
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK100000000001
    slugs:
      - task-dep-1
    title: Dependency Task 1
    status: completed
    spec_ref: "@test-feature"
  - _ulid: 01JHNKAB01TASK200000000002
    slugs:
      - task-dep-2
    title: Dependency Task 2
    status: completed
  - _ulid: 01JHNKAB01TASK300000000003
    slugs:
      - task-parent
    title: Parent Task
    status: pending
    depends_on:
      - "@task-dep-1"
      - "@task-dep-2"
`,
    );

    // Run validate --staleness
    const result = kspec("validate --staleness", tmpDir);

    expect(result).toContain("Staleness warnings");
    expect(result).toContain("task-parent");
    expect(result).toContain("all dependencies are completed");
  });

  // AC: @stale-status-detection spec-implemented-no-task
  it("should warn when spec is implemented but has no completed tasks", async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec marked as implemented
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - orphan-spec
  title: Orphan Spec
  type: requirement
  status:
    implementation: implemented
`,
    );

    // Create task file with no completed tasks for this spec
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK0000000000A1
    slugs:
      - unrelated-task
    title: Unrelated Task
    status: completed
`,
    );

    // Run validate --staleness
    const result = kspec("validate --staleness", tmpDir);

    expect(result).toContain("Staleness warnings");
    expect(result).toContain("orphan-spec");
    expect(result).toContain("no completed tasks");
  });

  // AC: @stale-status-detection task-done-spec-not-started
  it("should warn when task is completed but spec is not_started", async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec marked as not_started
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - stale-spec
  title: Stale Spec
  type: requirement
  status:
    implementation: not_started
`,
    );

    // Create completed task referencing the not_started spec
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK0000000000A1
    slugs:
      - completed-task
    title: Completed Task
    status: completed
    spec_ref: "@stale-spec"
`,
    );

    // Run validate --staleness
    const result = kspec("validate --staleness", tmpDir);

    expect(result).toContain("Staleness warnings");
    expect(result).toContain("completed-task");
    expect(result).toContain("stale-spec");
    expect(result).toContain("not_started");
  });

  // AC: @stale-status-detection staleness-flag
  it("should only run staleness checks when --staleness flag is provided", async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec marked as not_started
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - stale-spec
  title: Stale Spec
  type: requirement
  status:
    implementation: not_started
`,
    );

    // Create completed task referencing the not_started spec
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK0000000000A1
    slugs:
      - completed-task
    title: Completed Task
    status: completed
    spec_ref: "@stale-spec"
`,
    );

    // Run validate WITHOUT --staleness flag
    const resultWithoutFlag = kspec("validate", tmpDir);

    // Should NOT contain staleness warnings
    expect(resultWithoutFlag).not.toContain("Staleness warnings");

    // Run validate WITH --staleness flag
    const resultWithFlag = kspec("validate --staleness", tmpDir);

    // Should contain staleness warnings
    expect(resultWithFlag).toContain("Staleness warnings");
  });

  // AC: @stale-status-detection staleness-exit-code
  it("should exit with code 0 by default, or code 4 with --strict", async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec marked as not_started
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - stale-spec
  title: Stale Spec
  type: requirement
  status:
    implementation: not_started
`,
    );

    // Create completed task referencing the not_started spec
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK0000000000A1
    slugs:
      - completed-task
    title: Completed Task
    status: completed
    spec_ref: "@stale-spec"
`,
    );

    // Run validate --staleness (without --strict) - should exit 0
    const resultNoStrict = kspecWithStatus("validate --staleness", tmpDir);
    expect(resultNoStrict.exitCode).toBe(0);

    // Run validate --staleness --strict - should exit 4
    const resultStrict = kspecWithStatus(
      "validate --staleness --strict",
      tmpDir,
    );
    expect(resultStrict.exitCode).toBe(4);
  });

  // Additional test: No staleness warnings when everything is aligned
  it('should show "Staleness: OK" when no issues found', async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec marked as implemented
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01SPEC0000000000A1
  slugs:
    - aligned-spec
  title: Aligned Spec
  type: requirement
  status:
    implementation: implemented
`,
    );

    // Create completed task referencing the implemented spec
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK0000000000A1
    slugs:
      - aligned-task
    title: Aligned Task
    status: completed
    spec_ref: "@aligned-spec"
`,
    );

    // Run validate --staleness
    const result = kspec("validate --staleness", tmpDir);

    expect(result).toContain("Staleness: OK");
  });

  // AC: @validation ac-1
  it("should warn when manual_only parent blocks eligible children", async () => {
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
tasks:
  - "spec/test.tasks.yaml"
`,
    );

    // Create a spec module
    await fs.writeFile(
      path.join(specDir, "module.yaml"),
      `- _ulid: 01JHNKAB01TESTSPEC00000001
  slugs:
    - test-feature
  title: Test Feature
  type: feature
  status:
    implementation: not_started
`,
    );

    // Create task file with manual_only parent and eligible children
    await fs.writeFile(
      path.join(specDir, "test.tasks.yaml"),
      `tasks:
  - _ulid: 01JHNKAB01TASK100000000001
    slugs:
      - manual-parent
    title: Manual Only Parent Task
    status: pending
    automation: manual_only
  - _ulid: 01JHNKAB01TASK200000000002
    slugs:
      - eligible-child-1
    title: Eligible Child Task 1
    status: pending
    automation: eligible
    depends_on:
      - "@manual-parent"
  - _ulid: 01JHNKAB01TASK300000000003
    slugs:
      - eligible-child-2
    title: Eligible Child Task 2
    status: pending
    automation: eligible
    depends_on:
      - "@manual-parent"
`,
    );

    // Run validate --staleness
    const result = kspec("validate --staleness", tmpDir);

    expect(result).toContain("Staleness warnings");
    expect(result).toContain("Automation blocking");
    expect(result).toContain("manual-parent");
    expect(result).toContain("eligible-child-1");
    expect(result).toContain("eligible-child-2");
    expect(result).toContain("manual_only and blocks");
  });
});
