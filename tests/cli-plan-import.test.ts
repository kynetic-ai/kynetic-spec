/**
 * CLI Plan Import Tests
 * AC: @plan-import ac-11 through ac-33
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
} from "./helpers/cli";

describe("Integration: plan import", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-import ac-11
  it("should parse specs from ## Specs YAML block", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
  description: First feature
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Would create spec: @feature-one");
  });

  // AC: @plan-import ac-12
  it("should auto-derive tasks when derive_from_specs is true", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Would create spec: @feature-one");
    expect(output).toContain("Would derive task:");
    expect(output).toContain("from @feature-one");
  });

  // AC: @plan-import ac-13
  it("should add implementation notes to derived tasks", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`

## Tasks

derive_from_specs: true

## Implementation Notes

Use pattern X for implementation.
Follow coding standards Y.
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Check that task has the implementation notes
    const tasks = kspecJson<Array<{ notes: Array<{ content: string }> }>>(
      "task list --json",
      tempDir,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toHaveLength(1);
    expect(tasks[0].notes[0].content).toContain("Implementation notes from plan");
    expect(tasks[0].notes[0].content).toContain("Use pattern X");
  });

  // AC: @plan-import ac-14, ac-25
  it("should skip existing specs with warning", async () => {
    // Create a spec first
    kspec(
      'item add --under @test-core --title "Existing Feature" --slug existing-feature',
      tempDir,
    );

    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Existing Feature
  slug: existing-feature
  type: feature
\`\`\`
`,
    );

    const output = kspec(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(output).toContain("Skipping existing spec: @existing-feature");
    expect(output).toContain("Already exists");
  });

  // AC: @plan-import ac-15
  it("should show what would be created in dry-run mode without making changes", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Dry run - no changes made");
    expect(output).toContain("Would create spec: @feature-one");

    // Verify nothing was actually created
    const items = kspecJson<Array<{ slugs: string[] }>>(
      "item list --json",
      tempDir,
    );
    const hasFeatureOne = items.some((item) =>
      item.slugs.includes("feature-one"),
    );
    expect(hasFeatureOne).toBe(false);
  });

  // AC: @plan-import ac-16
  it("should create specs in topological order (parents before children)", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Child Feature
  slug: child-feature
  type: feature
  parent: parent-feature

- title: Parent Feature
  slug: parent-feature
  type: feature
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );

    // Parent should appear before child in output
    const parentIndex = output.indexOf("@parent-feature");
    const childIndex = output.indexOf("@child-feature");
    expect(parentIndex).toBeGreaterThan(0);
    expect(childIndex).toBeGreaterThan(parentIndex);
  });

  // AC: @plan-import ac-17, ac-33
  it("should error on missing parent with recovery hint", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Child Feature
  slug: child-feature
  parent: nonexistent-parent
\`\`\`
`,
    );

    const output = kspec(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(output).toContain("Parent @nonexistent-parent not found");
    expect(output).toContain("Check parent exists or define it earlier in plan");
  });

  // AC: @plan-import ac-18
  it("should detect circular parent references", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
  slug: feature-a
  parent: feature-b

- title: Feature B
  slug: feature-b
  parent: feature-a
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain("Circular parent reference");
  });

  // AC: @plan-import ac-19
  it("should set both spec_ref and plan_ref on derived tasks", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{ spec_ref: string; plan_ref: string; slugs: string[] }>
    >("task list --json", tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec_ref).toBe("@feature-one");
    expect(tasks[0].plan_ref).toBe("@test-plan");
  });

  // AC: @plan-import ac-20
  it("should derive tasks with title 'Implement <spec title>'", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: JSON Output Mode
  slug: json-output
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<Array<{ title: string }>>(
      "task list --json",
      tempDir,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Implement JSON Output Mode");
  });

  // AC: @plan-import ac-21
  it("should error on malformed YAML with line info", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature
  invalid: [unclosed
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain("Malformed YAML");
  });

  // AC: @plan-import ac-22
  it("should error on spec missing required title field", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- slug: no-title-spec
  type: feature
\`\`\`
`,
    );

    const output = kspec(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(output).toContain("Spec at index 0 missing required field: title");
  });

  // AC: @plan-import ac-23, ac-29
  it("should create valid specs and report errors with exit code 0", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Valid Feature
  slug: valid-feature

- slug: invalid-no-title

- title: Another Valid
  slug: another-valid
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir);
    expect(result.exitCode).toBe(0); // SUCCESS despite errors
    expect(result.stdout).toContain("Created 2 specs");
    expect(result.stdout).toContain("Errors (1)");
  });

  // AC: @plan-import ac-24
  it("should add plan record with created spec/task refs", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const plan = kspecJson<{
      derived_specs: string[];
      derived_tasks: string[];
      status: string;
      source_path: string;
    }>("plan get @test-plan --json", tempDir);
    expect(plan.derived_specs).toContain("@feature-one");
    expect(plan.derived_tasks.length).toBeGreaterThan(0);
    expect(plan.status).toBe("active");
    expect(plan.source_path).toContain("test-plan.md");
  });

  // AC: @plan-import ac-26
  it("should update existing specs with --update flag", async () => {
    // Create initial spec
    kspec('item add --under @test-core --title "Feature" --slug my-feature', tempDir);

    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature Updated
  slug: my-feature
  description: New description
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --update`,
      tempDir,
    );
    expect(output).toContain("Updated spec: @my-feature");
  });

  // AC: @plan-import ac-27
  it("should create manual tasks from additional_tasks array", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
\`\`\`

## Tasks

\`\`\`yaml
- title: Manual Task One
  slug: manual-task
  priority: 1
  description: Manual implementation task
  tags:
    - manual
    - custom
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        spec_ref?: string;
        plan_ref: string;
        priority: number;
        tags: string[];
      }>
    >("task list --json", tempDir);

    const manualTask = tasks.find((t) => t.title === "Manual Task One");
    expect(manualTask).toBeDefined();
    expect(manualTask!.spec_ref).toBeUndefined();
    expect(manualTask!.plan_ref).toBe("@test-plan");
    expect(manualTask!.priority).toBe(1);
    expect(manualTask!.tags).toContain("manual");
  });

  // AC: @plan-import ac-28
  it("should make plan ref resolvable in kspec commands", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Should be able to reference the plan
    const plan = kspecJson<{ title: string }>(
      "plan get @test-plan --json",
      tempDir,
    );
    expect(plan.title).toBe("Test Plan");
  });

  // AC: @plan-import ac-32
  it("should output JSON when --json flag is used", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
\`\`\`
`,
    );

    const result = kspecJson<{
      plan: string;
      created_specs: string[];
      created_tasks: string[];
      errors: unknown[];
    }>(`plan import "${planPath}" --module @test-core --json`, tempDir);

    expect(result.plan).toBe("@test-plan");
    expect(result.created_specs).toContain("@feature-one");
    expect(result.errors).toBeDefined();
  });

  // Integration test: Full workflow
  it("should import complete plan with specs, tasks, and notes", async () => {
    const planPath = path.join(tempDir, "complete-plan.md");
    await fs.writeFile(
      planPath,
      `# Complete Feature Plan

## Specs

\`\`\`yaml
- title: Parent Feature
  slug: parent-feature
  type: feature
  description: Top-level feature

- title: Child Feature
  slug: child-feature
  type: feature
  parent: parent-feature
  description: Nested feature
\`\`\`

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Extra Manual Task
  slug: extra-task
  priority: 2
\`\`\`

## Implementation Notes

Follow existing patterns in the codebase.
Ensure backward compatibility.
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core`,
      tempDir,
    );

    expect(output).toContain("Created 2 specs");
    expect(output).toContain("Created 3 tasks"); // 2 derived + 1 manual

    // Verify plan record
    const plan = kspecJson<{
      derived_specs: string[];
      derived_tasks: string[];
    }>("plan get @complete-feature-plan --json", tempDir);
    expect(plan.derived_specs).toHaveLength(2);
    expect(plan.derived_tasks).toHaveLength(3);

    // Verify tasks have implementation notes
    const tasks = kspecJson<Array<{ notes: Array<{ content: string }> }>>(
      "task list --json",
      tempDir,
    );
    const derivedTasks = tasks.filter(
      (t) => t.notes.length > 0 && t.notes[0].content.includes("Implementation notes"),
    );
    expect(derivedTasks).toHaveLength(2); // Both derived tasks should have notes
  });
});
