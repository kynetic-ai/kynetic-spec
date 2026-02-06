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
  it("should add global implementation notes to plan record and reference to tasks", async () => {
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

    // Plan record should have the global implementation notes
    const plan = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @test-plan --json",
      tempDir,
    );
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].content).toContain("Implementation notes:");
    expect(plan.notes[0].content).toContain("Use pattern X");

    // Task without per-spec notes should get a reference to the plan
    const allTasks = kspecJson<Array<{ notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@test-plan");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toHaveLength(1);
    expect(tasks[0].notes[0].content).toContain("See plan @test-plan for implementation notes");
  });

  // AC: @plan-import ac-13 - Per-spec implementation notes
  it("should add per-spec implementation notes to the corresponding task only", async () => {
    const planPath = path.join(tempDir, "per-spec-notes.md");
    await fs.writeFile(
      planPath,
      `# Per Spec Notes Plan

## Specs

\`\`\`yaml
- title: Feature Alpha
  slug: feature-alpha
  type: feature
  implementation_notes: |
    Use pattern A for alpha implementation.

- title: Feature Beta
  slug: feature-beta
  type: feature
  implementation_notes: |
    Use pattern B for beta implementation.
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const allTasks = kspecJson<Array<{ title: string; notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@per-spec-notes-plan");

    expect(tasks).toHaveLength(2);

    const alphaTask = tasks.find(t => t.title === "Implement Feature Alpha");
    const betaTask = tasks.find(t => t.title === "Implement Feature Beta");

    expect(alphaTask).toBeDefined();
    expect(alphaTask!.notes).toHaveLength(1);
    expect(alphaTask!.notes[0].content).toContain("Use pattern A");
    expect(alphaTask!.notes[0].content).not.toContain("Use pattern B");

    expect(betaTask).toBeDefined();
    expect(betaTask!.notes).toHaveLength(1);
    expect(betaTask!.notes[0].content).toContain("Use pattern B");
    expect(betaTask!.notes[0].content).not.toContain("Use pattern A");
  });

  // AC: @plan-import ac-13 - Mixed: some specs with per-spec notes, some without
  it("should scope per-spec notes and reference plan for specs without", async () => {
    const planPath = path.join(tempDir, "mixed-notes.md");
    await fs.writeFile(
      planPath,
      `# Mixed Notes Plan

## Specs

\`\`\`yaml
- title: Feature With Notes
  slug: feature-with-notes
  type: feature
  implementation_notes: |
    Specific implementation details for this feature.

- title: Feature Without Notes
  slug: feature-without-notes
  type: feature
\`\`\`

## Tasks

derive_from_specs: true

## Implementation Notes

Global architecture notes for the plan.
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const allTasks = kspecJson<Array<{ title: string; notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@mixed-notes-plan");

    expect(tasks).toHaveLength(2);

    const withNotes = tasks.find(t => t.title === "Implement Feature With Notes");
    const withoutNotes = tasks.find(t => t.title === "Implement Feature Without Notes");

    // Task with per-spec notes gets those notes
    expect(withNotes).toBeDefined();
    expect(withNotes!.notes).toHaveLength(1);
    expect(withNotes!.notes[0].content).toContain("Specific implementation details");
    expect(withNotes!.notes[0].content).not.toContain("See plan");

    // Task without per-spec notes gets plan reference
    expect(withoutNotes).toBeDefined();
    expect(withoutNotes!.notes).toHaveLength(1);
    expect(withoutNotes!.notes[0].content).toContain("See plan @mixed-notes-plan for implementation notes");

    // Plan record should have global notes
    const plan = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @mixed-notes-plan --json",
      tempDir,
    );
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].content).toContain("Global architecture notes");
  });

  // AC: @plan-import ac-13 - Backward compatibility: old format without per-spec notes
  it("should handle old-format plan without per-spec notes", async () => {
    const planPath = path.join(tempDir, "old-format.md");
    await fs.writeFile(
      planPath,
      `# Old Format Plan

## Specs

\`\`\`yaml
- title: Legacy Feature
  slug: legacy-feature
  type: feature
\`\`\`

## Tasks

derive_from_specs: true

## Implementation Notes

These are the global notes only.
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Plan record should have global notes
    const plan = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @old-format-plan --json",
      tempDir,
    );
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].content).toContain("These are the global notes only");

    // Task should get plan reference (not the full global notes)
    const allTasks = kspecJson<Array<{ notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@old-format-plan");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toHaveLength(1);
    expect(tasks[0].notes[0].content).toContain("See plan @old-format-plan for implementation notes");
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
    // Check summary output (stdout)
    expect(output).toContain("Skipped (1)");
    expect(output).toContain("@existing-feature");
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
    const result = kspecJson<{ items: Array<{ slugs: string[] }> }>(
      "item list --json",
      tempDir,
    );
    const hasFeatureOne = result.items.some((item) =>
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

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir, { expectFail: true });
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

    const allTasks = kspecJson<
      Array<{ spec_ref: string; plan_ref: string; slugs: string[] }>
    >("task list --json", tempDir);
    const tasks = allTasks.filter(t => t.plan_ref === "@test-plan");
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

    const allTasks = kspecJson<Array<{ title: string; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@test-plan");
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

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir, { expectFail: true });
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

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir);
    // Check error appears in summary (stdout) or warning (stderr)
    const allOutput = result.stdout + result.stderr;
    expect(allOutput).toContain("missing required field: title");
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
    }>(`plan import "${planPath}" --module @test-core`, tempDir);

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

    // Verify plan record has global implementation notes
    const planRecord = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @complete-feature-plan --json",
      tempDir,
    );
    expect(planRecord.notes).toHaveLength(1);
    expect(planRecord.notes[0].content).toContain("Follow existing patterns");

    // Verify derived tasks reference the plan (no per-spec notes in this plan)
    const tasks = kspecJson<Array<{ notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const derivedTasks = tasks.filter(
      (t) => t.plan_ref === "@complete-feature-plan" && t.notes.length > 0 && t.notes[0].content.includes("See plan"),
    );
    expect(derivedTasks).toHaveLength(2); // Both derived tasks should reference the plan
  });

  // Bug fix: acceptance criteria should be preserved during import
  it("should preserve acceptance criteria on imported specs", async () => {
    const planPath = path.join(tempDir, "ac-plan.md");
    await fs.writeFile(
      planPath,
      `# AC Plan

## Specs

\`\`\`yaml
- title: Feature With ACs
  slug: feature-with-acs
  type: feature
  acceptance_criteria:
    - id: ac-1
      given: a precondition
      when: an action occurs
      then: expected result
    - id: ac-2
      given: another precondition
      when: another action
      then: another result
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const item = kspecJson<{
      acceptance_criteria?: Array<{ id: string; given: string; when: string; then: string }>;
    }>("item get @feature-with-acs --json", tempDir);
    expect(item.acceptance_criteria).toHaveLength(2);
    expect(item.acceptance_criteria![0].id).toBe("ac-1");
    expect(item.acceptance_criteria![1].id).toBe("ac-2");
  });

  // Bug fix: bare trait names should get @ prefix during import
  it("should normalize bare trait names with @ prefix", async () => {
    const planPath = path.join(tempDir, "trait-plan.md");
    await fs.writeFile(
      planPath,
      `# Trait Plan

## Specs

\`\`\`yaml
- title: Feature With Traits
  slug: feature-with-traits
  type: feature
  traits:
    - trait-json-output
    - "@trait-dry-run"
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const item = kspecJson<{ traits: string[] }>(
      "item get @feature-with-traits --json",
      tempDir,
    );
    expect(item.traits).toContain("@trait-json-output");
    expect(item.traits).toContain("@trait-dry-run");
    expect(item.traits).not.toContain("trait-json-output");
  });

  // Bug fix: dry-run path should also preserve ACs and normalize traits
  it("should normalize traits in dry-run mode (no crash)", async () => {
    const planPath = path.join(tempDir, "dry-trait-plan.md");
    await fs.writeFile(
      planPath,
      `# Dry Trait Plan

## Specs

\`\`\`yaml
- title: Dry Feature
  slug: dry-feature
  type: feature
  traits:
    - bare-trait
  acceptance_criteria:
    - id: ac-1
      given: precondition
      when: action
      then: result
\`\`\`
`,
    );

    // Should not crash and should report the spec
    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Would create spec: @dry-feature");
  });
});
