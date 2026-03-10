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

    // Plan record should have the global implementation notes (with plan- prefix)
    const plan = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @plan-test-plan --json",
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
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-test-plan");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toHaveLength(1);
    expect(tasks[0].notes[0].content).toContain("See plan @plan-test-plan for implementation notes");
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
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-per-spec-notes-plan");

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
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-mixed-notes-plan");

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
    expect(withoutNotes!.notes[0].content).toContain("See plan @plan-mixed-notes-plan for implementation notes");

    // Plan record should have global notes
    const plan = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @plan-mixed-notes-plan --json",
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
      "plan get @plan-old-format-plan --json",
      tempDir,
    );
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].content).toContain("These are the global notes only");

    // Task should get plan reference (not the full global notes)
    const allTasks = kspecJson<Array<{ notes: Array<{ content: string }>; plan_ref: string }>>(
      "task list --json",
      tempDir,
    );
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-old-format-plan");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toHaveLength(1);
    expect(tasks[0].notes[0].content).toContain("See plan @plan-old-format-plan for implementation notes");
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
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-test-plan");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec_ref).toBe("@feature-one");
    expect(tasks[0].plan_ref).toBe("@plan-test-plan");
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
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-test-plan");
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

  // AC: @plan-import ac-21, ac-37 - YAML-unsafe diagnostic for unquoted colons
  it("should provide diagnostic hints when AC values contain unquoted colons", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Test Plan

## Specs

\`\`\`yaml
- title: Input Validation
  acceptance_criteria:
    - id: ac-1
      given: User enters data
      when: Form is submitted
      then: User sees error: Invalid input
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}" --module @test-core`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain("Malformed YAML");
    expect(result.stderr).toContain("Hint:");
    expect(result.stderr).toContain("then");
    expect(result.stderr).toContain("unquoted colon");
    expect(result.stderr).toContain("block scalars");
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
    }>("plan get @plan-test-plan --json", tempDir);
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

  // AC: @plan-import ac-26 - Merge ACs by id when updating existing specs
  it("should merge acceptance criteria by id on --update", async () => {
    const initialPlanPath = path.join(tempDir, "initial-ac-plan.md");
    await fs.writeFile(
      initialPlanPath,
      `# Initial AC Plan

## Specs

\`\`\`yaml
- title: Feature
  slug: ac-feature
  acceptance_criteria:
    - id: ac-1
      given: Original one
      when: Initial state
      then: First behavior
    - id: ac-2
      given: Original two
      when: Initial state
      then: Second behavior
\`\`\`
`,
    );
    kspec(`plan import "${initialPlanPath}" --module @test-core`, tempDir);

    const updatePlanPath = path.join(tempDir, "update-ac-plan.md");
    await fs.writeFile(
      updatePlanPath,
      `# Update AC Plan

## Specs

\`\`\`yaml
- title: Feature
  slug: ac-feature
  description: Updated with merged ACs
  acceptance_criteria:
    - id: ac-2
      given: Updated two
      when: Updated state
      then: Updated second behavior
    - id: ac-3
      given: New three
      when: Added state
      then: Third behavior
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${updatePlanPath}" --module @test-core --update`,
      tempDir,
    );
    expect(output).toContain("Updated spec: @ac-feature");

    const afterSpec = kspecJson<{
      description: string;
      acceptance_criteria: Array<{ id: string; given: string; when: string; then: string }>;
    }>("item get @ac-feature --json", tempDir);

    expect(afterSpec.description).toBe("Updated with merged ACs");
    expect(afterSpec.acceptance_criteria).toHaveLength(3);
    expect(afterSpec.acceptance_criteria.map(ac => ac.id)).toEqual(["ac-1", "ac-2", "ac-3"]);
    expect(afterSpec.acceptance_criteria[0].given).toBe("Original one");
    expect(afterSpec.acceptance_criteria[1].given).toBe("Updated two");
    expect(afterSpec.acceptance_criteria[2].given).toBe("New three");
  });

  // AC: @plan-import ac-26 - Omitted AC field should preserve existing ACs
  it("should preserve acceptance criteria when update spec omits acceptance_criteria", async () => {
    const initialPlanPath = path.join(tempDir, "preserve-ac-initial.md");
    await fs.writeFile(
      initialPlanPath,
      `# Preserve AC Initial

## Specs

\`\`\`yaml
- title: Preserve Feature
  slug: preserve-feature
  acceptance_criteria:
    - id: ac-1
      given: Preserve this
      when: Existing spec
      then: Keep AC
\`\`\`
`,
    );
    kspec(`plan import "${initialPlanPath}" --module @test-core`, tempDir);

    const updatePlanPath = path.join(tempDir, "preserve-ac-update.md");
    await fs.writeFile(
      updatePlanPath,
      `# Preserve AC Update

## Specs

\`\`\`yaml
- title: Preserve Feature
  slug: preserve-feature
  description: Description only change
\`\`\`
`,
    );
    kspec(`plan import "${updatePlanPath}" --module @test-core --update`, tempDir);

    const afterSpec = kspecJson<{
      description: string;
      acceptance_criteria: Array<{ id: string; given: string }>;
    }>("item get @preserve-feature --json", tempDir);

    expect(afterSpec.description).toBe("Description only change");
    expect(afterSpec.acceptance_criteria).toHaveLength(1);
    expect(afterSpec.acceptance_criteria[0].id).toBe("ac-1");
    expect(afterSpec.acceptance_criteria[0].given).toBe("Preserve this");
  });

  // AC: @plan-import ac-26 - Empty existing ACs should be populated from plan update
  it("should add acceptance criteria when existing spec has none and update includes ACs", async () => {
    kspec('item add --under @test-core --title "Empty Feature" --slug empty-feature', tempDir);

    const updatePlanPath = path.join(tempDir, "empty-ac-update.md");
    await fs.writeFile(
      updatePlanPath,
      `# Empty AC Update

## Specs

\`\`\`yaml
- title: Empty Feature
  slug: empty-feature
  acceptance_criteria:
    - id: ac-1
      given: New condition
      when: Update is applied
      then: AC exists
\`\`\`
`,
    );
    kspec(`plan import "${updatePlanPath}" --module @test-core --update`, tempDir);

    const afterSpec = kspecJson<{
      acceptance_criteria: Array<{ id: string; given: string }>;
    }>("item get @empty-feature --json", tempDir);

    expect(afterSpec.acceptance_criteria).toHaveLength(1);
    expect(afterSpec.acceptance_criteria[0].id).toBe("ac-1");
    expect(afterSpec.acceptance_criteria[0].given).toBe("New condition");
  });

  // AC: @plan-import ac-26 - Verify traits are updated
  it("should update traits on existing specs with --update flag", async () => {
    // Create initial spec
    kspec('item add --under @test-core --title "Feature" --slug trait-feature', tempDir);

    const planPath = path.join(tempDir, "update-traits-plan.md");
    await fs.writeFile(
      planPath,
      `# Update Traits Plan

## Specs

\`\`\`yaml
- title: Feature
  slug: trait-feature
  type: requirement
  traits:
    - json-output
    - cli-command
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --update`,
      tempDir,
    );
    expect(output).toContain("Updated spec: @trait-feature");

    // Verify traits were updated
    const afterSpec = kspecJson<{
      type: string;
      traits: string[];
    }>("item get @trait-feature --json", tempDir);

    expect(afterSpec.type).toBe("requirement");
    expect(afterSpec.traits).toContain("@json-output");
    expect(afterSpec.traits).toContain("@cli-command");
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
    expect(manualTask!.plan_ref).toBe("@plan-test-plan");
    expect(manualTask!.priority).toBe(1);
    expect(manualTask!.tags).toContain("manual");
  });

  // AC: @plan-import ac-27 — manual task with explicit spec_ref honors the ref
  it("should honor spec_ref on manual tasks when explicitly provided", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Spec Ref Plan

## Specs

\`\`\`yaml
- title: Target Spec
  slug: target-spec
\`\`\`

## Tasks

\`\`\`yaml
- title: Manual With Spec Ref
  slug: manual-with-ref
  spec_ref: "@target-spec"
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        spec_ref?: string;
        plan_ref: string;
      }>
    >("task list --json", tempDir);

    const manualTask = tasks.find((t) => t.title === "Manual With Spec Ref");
    expect(manualTask).toBeDefined();
    expect(manualTask!.spec_ref).toBe("@target-spec");
    expect(manualTask!.plan_ref).toBe("@plan-spec-ref-plan");
  });

  // AC: @plan-import ac-27 — manual task spec_ref is normalized with @ prefix
  it("should normalize spec_ref on manual tasks (add @ prefix)", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Normalize Plan

## Specs

\`\`\`yaml
- title: Norm Spec
  slug: norm-spec
\`\`\`

## Tasks

\`\`\`yaml
- title: Manual Bare Ref
  slug: manual-bare-ref
  spec_ref: norm-spec
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        spec_ref?: string;
      }>
    >("task list --json", tempDir);

    const manualTask = tasks.find((t) => t.title === "Manual Bare Ref");
    expect(manualTask).toBeDefined();
    // Should be normalized with @ prefix even though YAML said "norm-spec"
    expect(manualTask!.spec_ref).toBe("@norm-spec");
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
      "plan get @plan-test-plan --json",
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

    expect(result.plan).toBe("@plan-test-plan");
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
    }>("plan get @plan-complete-feature-plan --json", tempDir);
    expect(plan.derived_specs).toHaveLength(2);
    expect(plan.derived_tasks).toHaveLength(3);

    // Verify plan record has global implementation notes
    const planRecord = kspecJson<{ notes: Array<{ content: string }> }>(
      "plan get @plan-complete-feature-plan --json",
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
      (t) => t.plan_ref === "@plan-complete-feature-plan" && t.notes.length > 0 && t.notes[0].content.includes("See plan"),
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

  // Auto-namespace plan slugs
  it("should auto-namespace plan slug with plan- prefix", async () => {
    const planPath = path.join(tempDir, "namespace-test.md");
    await fs.writeFile(
      planPath,
      `# Namespace Test

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Plan slug should have plan- prefix
    const plan = kspecJson<{ slugs: string[] }>(
      "plan get @plan-namespace-test --json",
      tempDir,
    );
    expect(plan.slugs).toContain("plan-namespace-test");
  });

  it("should auto-generate unique plan slugs when importing same title twice", async () => {
    // Import the same plan twice
    const planPath = path.join(tempDir, "duplicate-plan.md");
    await fs.writeFile(
      planPath,
      `# Duplicate Import

## Specs

\`\`\`yaml
- title: Feature
  slug: duplicate-feature
  type: feature
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Create new spec slug for second import to avoid skip
    await fs.writeFile(
      planPath,
      `# Duplicate Import

## Specs

\`\`\`yaml
- title: Feature Two
  slug: duplicate-feature-two
  type: feature
\`\`\`
`,
    );
    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Both plans should be retrievable with different slugs
    const plan1 = kspecJson<{ slugs: string[] }>(
      "plan get @plan-duplicate-import --json",
      tempDir,
    );
    expect(plan1.slugs).toContain("plan-duplicate-import");

    const plan2 = kspecJson<{ slugs: string[] }>(
      "plan get @plan-duplicate-import-1 --json",
      tempDir,
    );
    expect(plan2.slugs).toContain("plan-duplicate-import-1");
  });

  // AC: @plan-import ac-11 - Trait type specs are created correctly in project-level traits
  it("should place parentless trait items in project-level traits array", async () => {
    const planPath = path.join(tempDir, "trait-type-plan.md");
    await fs.writeFile(
      planPath,
      `# Trait Type Plan

## Specs

\`\`\`yaml
- title: JSON Output
  slug: trait-json-output
  type: trait
  description: Cross-cutting trait for JSON output support
  acceptance_criteria:
    - id: ac-1
      given: A command supports --json
      when: --json flag is passed
      then: Output is valid JSON
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Verify the trait was created and is retrievable
    const item = kspecJson<{
      type: string;
      description: string;
      acceptance_criteria: Array<{ id: string }>;
    }>("item get @trait-json-output --json", tempDir);

    expect(item.type).toBe("trait");
    expect(item.description).toBe("Cross-cutting trait for JSON output support");
    expect(item.acceptance_criteria).toHaveLength(1);
    // Trait should be sourced from kynetic.yaml (project-level), not a module file
    const kyneticYaml = await fs.readFile(path.join(tempDir, "kynetic.yaml"), "utf8");
    expect(kyneticYaml).toContain("trait-json-output");
  });

  // AC: @plan-import ac-11 - Trait type specs with parent go under parent, not project-level
  it("should place trait items with a parent under the parent (not project-level)", async () => {
    const planPath = path.join(tempDir, "child-trait-plan.md");
    await fs.writeFile(
      planPath,
      `# Child Trait Plan

## Specs

\`\`\`yaml
- title: Parent Feature
  slug: parent-for-trait
  type: feature
  description: Parent feature

- title: Scoped Trait
  slug: scoped-trait
  type: trait
  parent: parent-for-trait
  description: Trait scoped under a parent
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Verify both items were created
    const parent = kspecJson<{ type: string }>("item get @parent-for-trait --json", tempDir);
    expect(parent.type).toBe("feature");

    const trait = kspecJson<{ type: string }>(
      "item get @scoped-trait --json",
      tempDir,
    );
    expect(trait.type).toBe("trait");
    // Trait with parent should NOT be in kynetic.yaml - it should be in the module file
    const kyneticYaml = await fs.readFile(path.join(tempDir, "kynetic.yaml"), "utf8");
    expect(kyneticYaml).not.toContain("scoped-trait");
  });

  // AC: @plan-import ac-15 - Dry-run reports project-level trait placement
  it("should report project-level trait placement in dry-run mode", async () => {
    const planPath = path.join(tempDir, "dry-trait-type-plan.md");
    await fs.writeFile(
      planPath,
      `# Dry Trait Type Plan

## Specs

\`\`\`yaml
- title: Dry Run Trait
  slug: dry-run-trait
  type: trait
  description: A trait in dry-run mode
\`\`\`
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Would create spec: @dry-run-trait");
    expect(output).toContain("(project-level trait)");
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

  // AC: @plan-import ac-35 - depends_on on specs
  it("should populate depends_on on created specs", async () => {
    const planPath = path.join(tempDir, "depends-on-plan.md");
    await fs.writeFile(
      planPath,
      `# Depends On Plan

## Specs

\`\`\`yaml
- title: Base Feature
  slug: base-feature
  type: feature

- title: Dependent Feature
  slug: dependent-feature
  type: feature
  depends_on:
    - base-feature
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // Base spec should have no depends_on
    const baseSpec = kspecJson<{ depends_on: string[] }>(
      "item get @base-feature --json",
      tempDir,
    );
    expect(baseSpec.depends_on).toEqual([]);

    // Dependent spec should have depends_on populated
    const depSpec = kspecJson<{ depends_on: string[] }>(
      "item get @dependent-feature --json",
      tempDir,
    );
    expect(depSpec.depends_on).toContain("@base-feature");
  });

  // AC: @plan-import ac-35 - derived tasks inherit depends_on mapped from spec slugs to task slugs
  it("should map spec depends_on to derived task depends_on using task slugs", async () => {
    const planPath = path.join(tempDir, "task-depends-plan.md");
    await fs.writeFile(
      planPath,
      `# Task Depends Plan

## Specs

\`\`\`yaml
- title: Foundation
  slug: foundation
  type: feature

- title: Building Block
  slug: building-block
  type: feature
  depends_on:
    - foundation
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const allTasks = kspecJson<
      Array<{ title: string; depends_on: string[]; plan_ref: string }>
    >("task list --json", tempDir);
    const tasks = allTasks.filter(t => t.plan_ref === "@plan-task-depends-plan");

    expect(tasks).toHaveLength(2);

    const foundationTask = tasks.find(t => t.title === "Implement Foundation");
    const buildingTask = tasks.find(t => t.title === "Implement Building Block");

    expect(foundationTask).toBeDefined();
    expect(foundationTask!.depends_on).toEqual([]);

    expect(buildingTask).toBeDefined();
    // The depends_on should reference the derived task slug, not the spec slug
    expect(buildingTask!.depends_on.length).toBe(1);
    expect(buildingTask!.depends_on[0]).toContain("implement-foundation");
  });

  // AC: @plan-import ac-35 - manual tasks honor depends_on directly
  it("should honor depends_on on manual tasks", async () => {
    const planPath = path.join(tempDir, "manual-depends-plan.md");
    await fs.writeFile(
      planPath,
      `# Manual Depends Plan

## Specs

\`\`\`yaml
- title: Some Feature
  slug: some-feature
  type: feature
\`\`\`

## Tasks

\`\`\`yaml
- title: Setup Task
  slug: setup-task

- title: Dependent Task
  slug: dependent-task
  depends_on:
    - setup-task
    - some-feature
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const allTasks = kspecJson<
      Array<{ title: string; depends_on: string[]; plan_ref: string }>
    >("task list --json", tempDir);
    const depTask = allTasks.find(t => t.title === "Dependent Task");

    expect(depTask).toBeDefined();
    expect(depTask!.depends_on).toContain("@setup-task");
    expect(depTask!.depends_on).toContain("@some-feature");
  });

  // AC: @plan-import ac-35 - depends_on refs are normalized with @ prefix
  it("should normalize depends_on refs with @ prefix", async () => {
    const planPath = path.join(tempDir, "normalize-depends-plan.md");
    await fs.writeFile(
      planPath,
      `# Normalize Depends Plan

## Specs

\`\`\`yaml
- title: Spec Alpha
  slug: spec-alpha
  type: feature

- title: Spec Beta
  slug: spec-beta
  type: feature
  depends_on:
    - spec-alpha
    - "@already-prefixed"
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const spec = kspecJson<{ depends_on: string[] }>(
      "item get @spec-beta --json",
      tempDir,
    );
    expect(spec.depends_on).toContain("@spec-alpha");
    expect(spec.depends_on).toContain("@already-prefixed");
  });

  // AC: @plan-import ac-35 - dry-run with depends_on should not crash
  it("should handle depends_on in dry-run mode", async () => {
    const planPath = path.join(tempDir, "dry-depends-plan.md");
    await fs.writeFile(
      planPath,
      `# Dry Depends Plan

## Specs

\`\`\`yaml
- title: Feature X
  slug: feature-x
  type: feature

- title: Feature Y
  slug: feature-y
  type: feature
  depends_on:
    - feature-x
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core --dry-run`,
      tempDir,
    );
    expect(output).toContain("Would create spec: @feature-x");
    expect(output).toContain("Would create spec: @feature-y");
    expect(output).toContain("Would derive task:");
  });

  // AC: @plan-import ac-35 - mixed import: new spec depends on existing spec with existing task
  it("should resolve depends_on to existing task ref when spec already exists", async () => {
    // Create an existing spec and derive a task from it
    kspec('item add --under @test-core --title "Existing Base" --slug existing-base', tempDir);
    kspec("derive @existing-base", tempDir);

    // Find the derived task slug
    const allTasks = kspecJson<Array<{ title: string; spec_ref: string; slugs: string[] }>>(
      "task list --json",
      tempDir,
    );
    const existingTask = allTasks.find(t => t.spec_ref === "@existing-base");
    expect(existingTask).toBeDefined();
    const existingTaskSlug = existingTask!.slugs[0];

    // Import a plan with a new spec that depends on the existing spec
    const planPath = path.join(tempDir, "mixed-depends-plan.md");
    await fs.writeFile(
      planPath,
      `# Mixed Depends Plan

## Specs

\`\`\`yaml
- title: New Feature
  slug: new-feature
  type: feature
  depends_on:
    - existing-base
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    // The derived task for new-feature should depend on the existing task, not the spec
    const updatedTasks = kspecJson<
      Array<{ title: string; depends_on: string[]; plan_ref: string }>
    >("task list --json", tempDir);
    const newTask = updatedTasks.find(t => t.title === "Implement New Feature");

    expect(newTask).toBeDefined();
    expect(newTask!.depends_on.length).toBe(1);
    expect(newTask!.depends_on[0]).toBe(`@${existingTaskSlug}`);
  });

  // AC: @plan-import ac-36 - Derived tasks inherit priority from spec
  it("should inherit priority from spec to derived task", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Priority Plan

## Specs

\`\`\`yaml
- title: Urgent Feature
  slug: urgent-feature
  type: feature
  priority: 1

- title: Normal Feature
  slug: normal-feature
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        priority: number;
        plan_ref: string;
      }>
    >("task list --json", tempDir);

    const urgentTask = tasks.find(
      (t) => t.title === "Implement Urgent Feature",
    );
    const normalTask = tasks.find(
      (t) => t.title === "Implement Normal Feature",
    );

    expect(urgentTask).toBeDefined();
    expect(urgentTask!.priority).toBe(1);

    expect(normalTask).toBeDefined();
    expect(normalTask!.priority).toBe(3); // Default when spec has no priority
  });

  // AC: @plan-import ac-36 - Spec priority values across full range
  it("should support priority values 1 through 5 on specs", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Priority Range Plan

## Specs

\`\`\`yaml
- title: Priority One
  slug: priority-one
  type: feature
  priority: 1

- title: Priority Two
  slug: priority-two
  type: feature
  priority: 2

- title: Priority Five
  slug: priority-five
  type: feature
  priority: 5
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        priority: number;
      }>
    >("task list --json", tempDir);

    const p1Task = tasks.find((t) => t.title === "Implement Priority One");
    const p2Task = tasks.find((t) => t.title === "Implement Priority Two");
    const p5Task = tasks.find((t) => t.title === "Implement Priority Five");

    expect(p1Task!.priority).toBe(1);
    expect(p2Task!.priority).toBe(2);
    expect(p5Task!.priority).toBe(5);
  });

  // AC: @plan-import ac-36 - Manual tasks still use their own priority
  it("should use manual task priority independently of spec priority", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Mixed Priority Plan

## Specs

\`\`\`yaml
- title: High Priority Spec
  slug: high-priority-spec
  type: feature
  priority: 1
\`\`\`

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Manual Low Priority
  slug: manual-low
  priority: 5

- title: Manual Default Priority
  slug: manual-default
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --module @test-core`, tempDir);

    const tasks = kspecJson<
      Array<{
        title: string;
        priority: number;
      }>
    >("task list --json", tempDir);

    const derivedTask = tasks.find(
      (t) => t.title === "Implement High Priority Spec",
    );
    const manualLow = tasks.find((t) => t.title === "Manual Low Priority");
    const manualDefault = tasks.find(
      (t) => t.title === "Manual Default Priority",
    );

    expect(derivedTask!.priority).toBe(1); // Inherited from spec
    expect(manualLow!.priority).toBe(5); // Explicit manual priority
    expect(manualDefault!.priority).toBe(3); // Default when no priority
  });

  // AC: @plan-import ac-36 - Invalid priority rejected by schema
  it("should reject spec with out-of-range priority", async () => {
    const planPath = path.join(tempDir, "test-plan.md");
    await fs.writeFile(
      planPath,
      `# Invalid Priority Plan

## Specs

\`\`\`yaml
- title: Invalid Feature
  slug: invalid-feature
  type: feature
  priority: 10
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    const output = kspec(
      `plan import "${planPath}" --module @test-core`,
      tempDir,
    );

    // Schema validation should catch the invalid priority and skip the spec
    expect(output).toContain("validation failed");

    // No task should be derived for the invalid spec
    const tasks = kspecJson<Array<{ title: string }>>(
      "task list --json",
      tempDir,
    );
    const invalidTask = tasks.find(
      (t) => t.title === "Implement Invalid Feature",
    );
    expect(invalidTask).toBeUndefined();
  });
});
